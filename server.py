"""
web-rtc/server.py — TTS 프록시 백엔드

브라우저는 GCP 키를 직접 호출할 수 없으므로 이 서버가 중계한다.
callbot/tts.py 의 GoogleTTS 를 그대로 임포트해서 재사용.

Endpoints:
  POST /tts  body={"text": "..."}  → audio/wav (24kHz 16-bit mono PCM)
"""
import struct
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

# ../callbot 을 import path 에 추가하고 그대로 모듈 재사용
_CALLBOT_DIR = Path(__file__).resolve().parent.parent / "callbot"
sys.path.insert(0, str(_CALLBOT_DIR))

from tts import GoogleTTS  # noqa: E402
import config as cfg  # noqa: E402


SAMPLE_RATE = 24000

app = FastAPI(title="web-rtc TTS proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

_tts: GoogleTTS | None = None


def _get_tts() -> GoogleTTS:
    global _tts
    if _tts is None:
        _tts = GoogleTTS(
            voice=cfg.GCP_TTS_VOICE,
            language_code="ko-KR",
            credentials_dir=cfg.CREDENTIALS_DIR,
        )
    return _tts


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

    pcm_24k = _get_tts().synthesize(text)
    wav = _wrap_pcm_in_wav(pcm_24k, SAMPLE_RATE)
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
