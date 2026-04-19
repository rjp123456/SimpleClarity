import logging
import os

import httpx

logger = logging.getLogger(__name__)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"


async def transcribe_audio(audio_bytes: bytes, audio_format: str = "mp4") -> str:
    if not ELEVENLABS_API_KEY:
        raise ValueError("ELEVENLABS_API_KEY not configured")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                STT_URL,
                headers={"xi-api-key": ELEVENLABS_API_KEY},
                files={
                    "file": (
                        f"audio.{audio_format}",
                        audio_bytes,
                        f"audio/{audio_format}",
                    )
                },
                data={"model_id": "scribe_v1"},
            )
            response.raise_for_status()
            result = response.json()
            transcript = str(result.get("text", "")).strip()
            return transcript
    except Exception as exc:
        logger.exception("ElevenLabs STT error: %s", exc)
        raise
