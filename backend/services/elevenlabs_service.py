import logging
import os

import httpx
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID")
ELEVENLABS_MODEL = "eleven_flash_v2_5"
ELEVENLABS_TTS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"


def _is_placeholder(value: str) -> bool:
    normalized = value.strip().lower()
    return normalized in {"", "your_api_key_here", "your_chosen_voice_id_here"}


def is_configured() -> bool:
    api_key = ELEVENLABS_API_KEY or ""
    voice_id = ELEVENLABS_VOICE_ID or ""
    return not _is_placeholder(api_key) and not _is_placeholder(voice_id)


async def text_to_speech(text: str) -> bytes:
    try:
        headers = {
            "xi-api-key": ELEVENLABS_API_KEY or "",
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }

        payload = {
            "text": text,
            "model_id": ELEVENLABS_MODEL,
            "voice_settings": {
                "stability": 0.75,
                "similarity_boost": 0.85,
                "style": 0.0,
                "use_speaker_boost": True,
            },
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                ELEVENLABS_TTS_URL,
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            return response.content
    except Exception as exc:
        logger.exception("ElevenLabs text_to_speech failed: %s", exc)
        raise
