import logging
import os

from fastapi import APIRouter, BackgroundTasks, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from services import elevenlabs_service, elevenlabs_stt_service, gemini_service
from services.supabase_service import get_client, supabase_is_configured

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


class ChatTextRequest(BaseModel):
    text: str


async def load_history(limit: int = 10) -> list[dict]:
    if not supabase_is_configured():
        return []
    try:
        client = get_client()
        result = (
            client.table("conversations")
            .select("role, content")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        history = result.data or []
        history.reverse()
        return history
    except Exception as exc:
        logger.warning("History load error: %s", exc)
        return []


async def save_turn(role: str, content: str):
    if not supabase_is_configured():
        return
    try:
        client = get_client()
        client.table("conversations").insert(
            {
                "role": role,
                "content": content,
            }
        ).execute()
    except Exception as exc:
        logger.warning("Conversation save error: %s", exc)


@router.post("/chat-text")
async def chat_text_endpoint(
    payload: ChatTextRequest,
    background_tasks: BackgroundTasks,
):
    transcript = str(payload.text or "").strip()
    if not transcript:
        return {"transcript": "", "response": "Please tell me what you need.", "audio_failed": True}

    background_tasks.add_task(save_turn, "user", transcript)
    history = await load_history(limit=10)
    response_text = await gemini_service.chat(transcript, history)
    background_tasks.add_task(save_turn, "assistant", response_text)
    status = gemini_service.get_last_status()
    return {
        "transcript": transcript,
        "response": response_text,
        "source": status.get("source", "fallback"),
        "model": status.get("model", ""),
        "error": status.get("error", ""),
    }


@router.get("/chat/health")
async def chat_health():
    status = gemini_service.get_last_status()
    models = await gemini_service.get_available_models()
    return {
        "gemini_api_key_configured": bool(gemini_service.GEMINI_API_KEY),
        "preferred_model": gemini_service.GEMINI_MODEL,
        "available_models": models,
        "last_status": status,
    }


@router.post("/chat")
async def chat_endpoint(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
):
    logger.debug("chat request received")
    audio_bytes = await audio.read()
    if not audio_bytes:
        return {"transcript": "", "response": "I didn't hear anything. Could you try again?", "audio_failed": True}
    file_name = str(audio.filename or "").strip().lower()
    extension = os.path.splitext(file_name)[1].lstrip(".")
    audio_format = extension or "m4a"

    try:
        logger.debug("transcribing audio format=%s bytes=%d", audio_format, len(audio_bytes))
        transcript = await elevenlabs_stt_service.transcribe_audio(
            audio_bytes,
            audio_format=audio_format,
        )
        logger.debug("transcript='%s'", transcript[:120])
    except Exception:
        fallback_text = "I'm sorry, I didn't catch that. Could you say that again?"
        logger.warning("STT failed, returning fallback")
        try:
            audio_response = await elevenlabs_service.text_to_speech(fallback_text)
            return Response(content=audio_response, media_type="audio/mpeg")
        except Exception:
            return {"transcript": "", "response": fallback_text, "audio_failed": True}

    if not transcript:
        fallback_text = "I didn't hear anything. Could you try again?"
        logger.debug("empty transcript, returning fallback")
        try:
            audio_response = await elevenlabs_service.text_to_speech(fallback_text)
            return Response(content=audio_response, media_type="audio/mpeg")
        except Exception:
            return {"transcript": "", "response": fallback_text, "audio_failed": True}

    background_tasks.add_task(save_turn, "user", transcript)
    history = await load_history(limit=10)
    logger.debug("loaded history turns=%d", len(history))
    response_text = await gemini_service.chat(transcript, history)
    logger.debug("assistant response='%s'", response_text[:120])
    background_tasks.add_task(save_turn, "assistant", response_text)

    try:
        audio_response = await elevenlabs_service.text_to_speech(response_text)
        return Response(
            content=audio_response,
            media_type="audio/mpeg",
            headers={
                "X-Transcript": transcript,
                "X-Response-Text": response_text,
            },
        )
    except Exception as exc:
        logger.exception("TTS error in chat: %s", exc)
        return {
            "transcript": transcript,
            "response": response_text,
            "audio_failed": True,
        }
