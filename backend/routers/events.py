from fastapi import APIRouter

from models import EventCreateRequest, EventCreateResponse
from services.supabase_service import log_event

router = APIRouter(tags=["events"])


@router.post("/events", response_model=EventCreateResponse)
async def create_event(request: EventCreateRequest) -> EventCreateResponse:
    logged = await log_event(request.type, request.payload)
    return EventCreateResponse(logged=logged)
