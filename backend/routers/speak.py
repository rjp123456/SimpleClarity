import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from services.elevenlabs_service import is_configured, text_to_speech

logger = logging.getLogger(__name__)
router = APIRouter(tags=["speech"])


class SpeakRequest(BaseModel):
    text: str


@router.post("/speak")
async def speak(payload: SpeakRequest):
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must be non-empty.")

    if not is_configured():
        return {
            "fallback": True,
            "text": text,
            "reason": "ElevenLabs not configured",
        }

    try:
        audio_bytes = await text_to_speech(text)
    except Exception as exc:
        logger.exception("ElevenLabs speak endpoint failed")
        return {
            "fallback": True,
            "text": text,
            "reason": f"ElevenLabs error: {type(exc).__name__}: {str(exc)}"[:300],
        }

    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": 'inline; filename="speech.mp3"',
            "Cache-Control": "no-cache",
        },
    )
