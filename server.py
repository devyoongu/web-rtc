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

# 로그 라인 정규식 (이전과 동일).
TTS_ENQUEUE_RE = re.compile(r"TTS enqueue: '(.+?)'")
TTS_EXTRAS_STT_RE  = re.compile(r"stt_to_bot=(\d+)ms")
TTS_EXTRAS_KIND_RE = re.compile(r"kind=(\w+)")
TTS_TTFA_RE = re.compile(
    r"TTS TTFA: '(.+?)' \(ttfa=(\d+)ms(?:, kind=(\w+))?\)"
)
LISTENING_RE = re.compile(r"Turn \d+: Listening\.\.\.")
STT_RESULT_RE = re.compile(
    r"STT result: success=(True|False), transcript='(.+?)'"
    r"(?:, (?:serverEND|clientEOS)_to_final=(\d+)ms)?"
)

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
                    m_ttfa = TTS_TTFA_RE.search(line)
                    if m_ttfa:
                        payload = {
                            "type": "tts_ttfa",
                            "text": m_ttfa.group(1),
                            "ttfa_ms": int(m_ttfa.group(2)),
                        }
                        if m_ttfa.group(3):
                            payload["kind"] = m_ttfa.group(3)
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
                    text = m.group(1)
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
