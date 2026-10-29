"""
web-rtc/server.py — 콜봇 로그 SSE + 봇 응답 WAV 정적 서빙.

TTS 합성은 별도 tts-service (default http://localhost:8001) 에 위임한다.
이 서버는 callbot 코드를 import 하지 않는다.

Endpoints:
  GET /events                       → text/event-stream
              callbot 로그(/tmp/callbot.log) 를 tail 하여 'TTS enqueue' 라인을
              파싱, 콜봇 응답 텍스트를 SSE 로 push. 각 응답 텍스트의 8kHz WAV
              를 tts-service 로 prefetch 해 wav/recv/ 에 저장하고 URL 을 함께 전달.
  GET /wav/recv/{name}              → 위 응답 WAV 파일 정적 서빙

  (브라우저의 사용자 발화 TTS 는 tts-service 의 POST /tts 를 직접 호출.)
"""
import asyncio
import json
import os
import re
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles


TTS_SERVICE_URL = os.environ.get("TTS_SERVICE_URL", "http://localhost:8001").rstrip("/")

# 송수신 WAV 보관 폴더. .gitignore 의 wav/ 로 제외됨.
_BASE_DIR = Path(__file__).resolve().parent
RECV_DIR = _BASE_DIR / "wav" / "recv"

# 콜봇 로그 경로 — main.py 를 `> /tmp/callbot.log 2>&1` 로 띄우는 패턴 가정.
LOG_PATH = Path(os.environ.get("CALLBOT_LOG_PATH", "/tmp/callbot.log"))

# 로그 라인 정규식.
# 콜봇은 텍스트를 repr()/!r 로 찍으므로 아포스트로피가 든 문장은 큰따옴표
# ("Hi! Let's..."), 없으면 작은따옴표('Great job...') 로 감싼다. 따옴표 문자를
# 캡처(group 1)해 백레퍼런스로 닫는 쪽을 맞춘다 — 두 스타일 모두 매칭.
TTS_ENQUEUE_RE = re.compile(r"TTS enqueue: (['\"])(.+?)\1")
TTS_EXTRAS_STT_RE  = re.compile(r"stt_to_bot=(\d+)ms")
TTS_EXTRAS_KIND_RE = re.compile(r"kind=(\w+)")
TTS_TTFA_RE = re.compile(
    r"TTS TTFA: (['\"])(.+?)\1 \(ttfa=(\d+)ms(?:, kind=(\w+))?\)"
)
LISTENING_RE = re.compile(r"Turn \d+: Listening\.\.\.")
STT_RESULT_RE = re.compile(
    r"STT result: success=(True|False), transcript='(.+?)'"
    r"(?:, (?:serverEND|clientEOS)_to_final=(\d+)ms)?"
)

# 끼어들기(barge-in) 이벤트 — callbot 의 INFO 로그를 타임라인 배지로 중계.
# (BARGE_IN_ENABLE=yes 일 때만 발생. 소스: barge_in_controller / detector / call_handler.)
BARGE_CONFIRM_RE = re.compile(r"GATE3 PASS -> BARGE-IN confirmed: '(.+?)'")
BARGE_DUCK_RE    = re.compile(r"TTS (ducked|unducked)(?: \((.+?)\))?")
BARGE_STOP_RE    = re.compile(r"TTS STOPPED \((.+?)\)(?: stop=(\d+)ms)?")
BARGE_HANDOFF_RE = re.compile(r"Barge-in during reply .* uses (.+)$")

app = FastAPI(title="web-rtc events bridge")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

RECV_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/wav/recv", StaticFiles(directory=RECV_DIR), name="recv")


def _save_wav(wav: bytes, text: str) -> Path:
    RECV_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    snippet = re.sub(r"[^\w가-힣]+", "_", text[:30]).strip("_") or "empty"
    path = RECV_DIR / f"{ts}-{snippet}.wav"
    path.write_bytes(wav)
    return path


@app.get("/health")
def health():
    return {"status": "ok", "tts_service_url": TTS_SERVICE_URL}


async def _prefetch_recv_wav(client: httpx.AsyncClient, text: str) -> Path | None:
    """tts-service 에 합성 요청 → 반환된 WAV 를 wav/recv/ 에 저장."""
    try:
        resp = await client.post(
            f"{TTS_SERVICE_URL}/tts",
            json={"text": text},
            timeout=30.0,
        )
        resp.raise_for_status()
        wav = resp.content
        saved = _save_wav(wav, text)
        print(f"[Events] Recv saved: {saved.relative_to(_BASE_DIR)} ({len(wav)} bytes)")
        return saved
    except Exception as e:
        print(f"[Events] prefetch failed for {text[:30]!r}: {e}")
        return None


@app.get("/events")
async def events():
    """callbot 로그 tail → SSE."""
    if not LOG_PATH.exists():
        raise HTTPException(status_code=404, detail=f"log not found: {LOG_PATH}")

    async def stream():
        f = LOG_PATH.open("r", encoding="utf-8", errors="replace")
        f.seek(0, 2)
        async with httpx.AsyncClient() as client:
            try:
                yield ": connected\n\n"
                while True:
                    line = f.readline()
                    if not line:
                        await asyncio.sleep(0.5)
                        continue
                    if LISTENING_RE.search(line):
                        yield f"data: {json.dumps({'type': 'listening'})}\n\n"
                        continue
                    # 끼어들기 이벤트 (ducked/unducked/confirm/stop/handoff).
                    m_bc = BARGE_CONFIRM_RE.search(line)
                    if m_bc:
                        payload = {"type": "barge", "stage": "confirm", "text": m_bc.group(1)}
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        continue
                    m_bs = BARGE_STOP_RE.search(line)
                    if m_bs:
                        payload = {"type": "barge", "stage": "stop", "detail": m_bs.group(1)}
                        if m_bs.group(2):
                            payload["stop_ms"] = int(m_bs.group(2))
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        continue
                    m_bh = BARGE_HANDOFF_RE.search(line)
                    if m_bh:
                        payload = {"type": "barge", "stage": "handoff", "text": m_bh.group(1).strip()}
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        continue
                    m_bd = BARGE_DUCK_RE.search(line)
                    if m_bd:
                        payload = {"type": "barge", "stage": m_bd.group(1)}
                        if m_bd.group(2):
                            payload["detail"] = m_bd.group(2)
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        continue
                    m_ttfa = TTS_TTFA_RE.search(line)
                    if m_ttfa:
                        payload = {
                            "type": "tts_ttfa",
                            "text": m_ttfa.group(2),
                            "ttfa_ms": int(m_ttfa.group(3)),
                        }
                        if m_ttfa.group(4):
                            payload["kind"] = m_ttfa.group(4)
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        continue
                    m_stt = STT_RESULT_RE.search(line)
                    if m_stt:
                        success = m_stt.group(1) == "True"
                        transcript = m_stt.group(2)
                        payload = {"type": "stt", "transcript": transcript, "success": success}
                        if m_stt.group(3):
                            payload["eos_to_final_ms"] = int(m_stt.group(3))
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        continue
                    m = TTS_ENQUEUE_RE.search(line)
                    if not m:
                        continue
                    text = m.group(2)
                    saved = await _prefetch_recv_wav(client, text)
                    payload = {"type": "bot_text", "text": text}
                    if saved is not None:
                        payload["url"] = f"/wav/recv/{saved.name}"
                    m_extra = TTS_EXTRAS_STT_RE.search(line)
                    if m_extra:
                        payload["stt_to_bot_ms"] = int(m_extra.group(1))
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
