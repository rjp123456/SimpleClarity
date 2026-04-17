from datetime import datetime, timezone
from typing import Union

from fastapi import APIRouter, BackgroundTasks, File, UploadFile

from models import (
    FaceIdentificationErrorResponse,
    FaceIdentificationMatchResponse,
    FaceIdentificationNoMatchResponse,
    SyncFacesResponse,
)
from services.deepface_service import identify_face_from_upload, sync_reference_photos
from services.supabase_service import log_event

router = APIRouter(tags=["face"])


@router.post(
    "/identify-face",
    response_model=Union[
        FaceIdentificationMatchResponse,
        FaceIdentificationNoMatchResponse,
        FaceIdentificationErrorResponse,
    ],
)
async def identify_face(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
):
    result = await identify_face_from_upload(image)

    if result.error:
        return FaceIdentificationErrorResponse(error=result.error)

    if not result.matched:
        return FaceIdentificationNoMatchResponse()

    background_tasks.add_task(
        log_event,
        "face_identified",
        {
            "name": result.name,
            "relationship": result.relationship,
            "confidence": result.confidence,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )

    return FaceIdentificationMatchResponse(
        name=result.name,
        relationship=result.relationship,
        confidence=result.confidence,
    )


@router.post("/sync-faces", response_model=SyncFacesResponse)
async def sync_faces() -> SyncFacesResponse:
    synced, local_path = sync_reference_photos()
    return SyncFacesResponse(synced=synced, local_path=local_path)
