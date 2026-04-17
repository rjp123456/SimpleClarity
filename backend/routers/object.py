import os
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

from models import ObjectIdentificationResponse
from services.openrouter_service import identify_relevant_object
from services.supabase_service import log_event

router = APIRouter(tags=["object"])


@router.post("/identify-object", response_model=ObjectIdentificationResponse)
async def identify_object(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
) -> ObjectIdentificationResponse:
    if image.content_type not in {"image/jpeg", "image/jpg", "image/png"}:
        raise HTTPException(status_code=400, detail="Image must be a JPEG or PNG file.")

    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY is not configured.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image upload was empty.")

    try:
        description = await identify_relevant_object(
            image_bytes=image_bytes,
            mime_type=image.content_type,
            api_key=api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    background_tasks.add_task(
        log_event,
        "object_identified",
        {
            "description": description,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )

    return ObjectIdentificationResponse(description=description)
