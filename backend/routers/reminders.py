from fastapi import APIRouter, HTTPException

from models import ReminderCreateRequest, ReminderResponse
from scheduler import remove_scheduled_reminder, schedule_reminder
from services.supabase_service import create_reminder, delete_reminder, get_all_reminders

router = APIRouter(tags=["reminders"])


@router.get("/reminders", response_model=list[ReminderResponse])
async def list_reminders() -> list[ReminderResponse]:
    return [ReminderResponse(**reminder) for reminder in get_all_reminders()]


@router.post("/reminders", response_model=ReminderResponse)
async def add_reminder(request: ReminderCreateRequest) -> ReminderResponse:
    reminder = create_reminder(request.model_dump())
    if reminder.get("active", True):
        schedule_reminder(reminder)
    return ReminderResponse(**reminder)


@router.delete("/reminders/{reminder_id}")
async def remove_reminder(reminder_id: str) -> dict[str, bool]:
    deleted = delete_reminder(reminder_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Reminder not found.")

    remove_scheduled_reminder(reminder_id)
    return {"deleted": True}
