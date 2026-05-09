"""
web-rtc/server.py — TTS 프록시 백엔드 + 콜봇 응답 SSE

브라우저는 GCP 키를 직접 호출할 수 없으므로 이 서버가 중계한다.
callbot/tts.py 의 GoogleTTS 를 그대로 임포트해서 재사용.

Endpoints:
  POST /tts  body={"text": "..."}  → audio/wav (8kHz 16-bit mono PCM)
              송신용. wav/sent/ 에 자동 저장.
  GET  /events                       → text/event-stream
              callbot 로그(/tmp/callbot.log) 를 tail 하여 'TTS enqueue' 라인을
              파싱, 콜봇 응답 텍스트를 SSE 로 push. 각 응답 텍스트의 8kHz WAV
              를 wav/recv/ 에 미리 합성/저장하고, 파일 URL 을 함께 전달.
  GET  /wav/recv/{name}              → 위 응답 wav 파일 정적 서빙
"""
import asyncio
import json
import os
import re
import struct
import sys
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ../callbot 을 import path 에 추가하고 그대로 모듈 재사용
_CALLBOT_DIR = Path(__file__).resolve().parent.parent / "callbot"
sys.path.insert(0, str(_CALLBOT_DIR))

from tts import synthesize_pcm_8k  # noqa: E402
import config as cfg  # noqa: E402


SAMPLE_RATE = 8000

# 송신/수신 WAV 보관 폴더 — callbot/tts.py 의 cache(wav/_cache/) 와 별도.
# .gitignore 의 wav/ 로 제외됨.
_BASE_DIR = Path(__file__).resolve().parent
SENT_DIR = _BASE_DIR / "wav" / "sent"
RECV_DIR = _BASE_DIR / "wav" / "recv"

# 콜봇 로그 경로 — main.py 를 `> /tmp/callbot.log 2>&1` 로 띄우는 패턴 가정.
# 환경에 맞게 CALLBOT_LOG_PATH 환경변수로 override.
LOG_PATH = Path(os.environ.get("CALLBOT_LOG_PATH", "/tmp/callbot.log"))

# callbot 의 'TTS enqueue:' 로그 라인 파싱.
# 본체 텍스트는 그대로 첫 작은따옴표 쌍으로 매칭.
TTS_ENQUEUE_RE = re.compile(r"TTS enqueue: '(.+?)'")
# 같은 라인에 옵션으로 붙는 extras (예: stt_to_bot=234ms, kind=meta_first).
TTS_EXTRAS_STT_RE  = re.compile(r"stt_to_bot=(\d+)ms")
TTS_EXTRAS_KIND_RE = re.compile(r"kind=(\w+)")
# callbot 의 'Turn N: Listening...' (STT window 시작) 라인 파싱.
LISTENING_RE = re.compile(r"Turn \d+: Listening\.\.\.")
# callbot 의 'STT result: success=..., transcript=...' 라인 파싱.
# 끝에 ", serverEND_to_final=Nms" 또는 ", clientEOS_to_final=Nms" 가 옵션으로 붙음.
STT_RESULT_RE = re.compile(
    r"STT result: success=(True|False), transcript='(.+?)'"
    r"(?:, (?:serverEND|clientEOS)_to_final=(\d+)ms)?"
)

app = FastAPI(title="web-rtc TTS proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

# /wav/recv/ 정적 서빙 — 봇 응답 wav 재생용.
RECV_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/wav/recv", StaticFiles(directory=RECV_DIR), name="recv")


def _save_wav(wav: bytes, text: str, target_dir: Path) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    # 파일명에 안전한 문자만 남김 (한글/영숫자/공백 → _)
    snippet = re.sub(r"[^\w가-힣]+", "_", text[:30]).strip("_") or "empty"
    path = target_dir / f"{ts}-{snippet}.wav"
    path.write_bytes(wav)
    return path


def _wrap_pcm_in_wav(pcm: bytes, sample_rate: int) -> bytes:
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ",
        16, 1, num_channels, sample_rate,
        byte_rate, block_align, bits_per_sample,
        b"data", len(pcm),
    )
    return header + pcm


class TTSRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"status": "ok", "voice": cfg.GCP_TTS_VOICE}


@app.post("/tts")
def synthesize(req: TTSRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text) > 5000:
        raise HTTPException(status_code=400, detail="text too long (>5000)")

    # callbot/tts.py 의 모듈 함수. 24kHz 합성 → anti-aliased 다운샘플 → 8kHz.
    # 디스크 캐시(wav/_cache/) 적용으로 동일 텍스트 재요청 시 GCP 호출 없음.
    pcm_8k = synthesize_pcm_8k(text)
    wav = _wrap_pcm_in_wav(pcm_8k, SAMPLE_RATE)
    saved = _save_wav(wav, text, SENT_DIR)
    print(f"[TTS] Sent saved: {saved.relative_to(_BASE_DIR)} ({len(wav)} bytes)")
    return Response(content=wav, media_type="audio/wav")


def _prefetch_recv_wav(text: str) -> Path | None:
    """봇 응답 텍스트의 8k WAV 를 미리 합성/저장. 파일 경로 반환."""
    try:
        pcm_8k = synthesize_pcm_8k(text)
        wav = _wrap_pcm_in_wav(pcm_8k, SAMPLE_RATE)
        saved = _save_wav(wav, text, RECV_DIR)
        print(f"[Events] Recv saved: {saved.relative_to(_BASE_DIR)} ({len(wav)} bytes)")
        return saved
    except Exception as e:
        print(f"[Events] prefetch failed for {text[:30]!r}: {e}")
        return None


@app.get("/events")
async def events():
    """
    callbot 로그를 tail 하여 SSE 로 두 종류 이벤트를 push.

    1) 봇 응답 텍스트 (TTS enqueue 라인):
       data: {"type": "bot_text", "text": "...", "url": "/wav/recv/<file>.wav"}
    2) STT Listening 윈도우 시작 (Turn N: Listening 라인):
       data: {"type": "listening"}
       — 브라우저는 이 시점에 발신해야 audio 가 STT window 안에 도달.
    """
    if not LOG_PATH.exists():
        raise HTTPException(status_code=404, detail=f"log not found: {LOG_PATH}")

    async def stream():
        f = LOG_PATH.open("r", encoding="utf-8", errors="replace")
        f.seek(0, 2)  # tail-end
        try:
            # 클라이언트에 즉시 헤더 flush 시킬 keep-alive ping
            yield ": connected\n\n"
            while True:
                line = f.readline()
                if not line:
                    await asyncio.sleep(0.5)
                    continue
                # Listening 윈도우 시작 (가장 빈도 높음, 먼저 매칭)
                if LISTENING_RE.search(line):
                    yield f"data: {json.dumps({'type': 'listening'})}\n\n"
                    continue
                # STT 인식 결과 (사용자 말풍선 하위 annotation 용)
                m_stt = STT_RESULT_RE.search(line)
                if m_stt:
                    success = m_stt.group(1) == "True"
                    transcript = m_stt.group(2)
                    payload = {"type": "stt", "transcript": transcript, "success": success}
                    if m_stt.group(3):
                        payload["eos_to_final_ms"] = int(m_stt.group(3))
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    continue
                # 봇 응답 텍스트
                m = TTS_ENQUEUE_RE.search(line)
                if not m:
                    continue
                text = m.group(1)
                # GCP 호출이 동기라 event loop 블로킹 방지
                saved = await asyncio.to_thread(_prefetch_recv_wav, text)
                payload = {"type": "bot_text", "text": text}
                if saved is not None:
                    payload["url"] = f"/wav/recv/{saved.name}"
                # 같은 라인의 extras (있으면) → SSE payload 에 동봉.
                m_stt = TTS_EXTRAS_STT_RE.search(line)
                if m_stt:
                    payload["stt_to_bot_ms"] = int(m_stt.group(1))
                m_kind = TTS_EXTRAS_KIND_RE.search(line)
                if m_kind:
                    payload["kind"] = m_kind.group(1)
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        finally:
            f.close()

    return StreamingResponse(stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
