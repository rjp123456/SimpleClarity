import asyncio
import logging
import threading
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from routers.chat import router as chat_router
from routers.device import router as device_router
from routers.events import router as events_router
from routers.face import router as face_router
from routers.geofence import router as geofence_router
from routers.medication import router as medication_router
from routers.object import router as object_router
from routers.reminders import router as reminders_router
from routers.speak import router as speak_router
from scheduler import shutdown_scheduler, start_scheduler
from services.detector_service import (
    CUSTOM_MODEL_PATH,
    DETECTION_CONFIDENCE_THRESHOLD,
    warmup_detector,
)
from services.wake_word_service import WAKE_WORD_ENABLED, run_wake_word_listener
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    logger.info(
        "Clarity detector config: path=%s threshold=%.2f",
        CUSTOM_MODEL_PATH,
        DETECTION_CONFIDENCE_THRESHOLD,
    )
    logger.info("Starting Clarity detector warmup...")
    asyncio.create_task(asyncio.to_thread(warmup_detector))
    if WAKE_WORD_ENABLED:
        wake_thread = threading.Thread(
            target=run_wake_word_listener,
            daemon=True,
            name="wake_word_listener",
        )
        wake_thread.start()
        logger.info("Wake word listener started in background thread")
    else:
        logger.info("Wake word listener disabled (set WAKE_WORD_ENABLED=true to enable)")
    yield
    shutdown_scheduler()


app = FastAPI(title="Clarity Lite Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Transcript", "X-Response-Text"],
)

app.include_router(object_router)
app.include_router(face_router)
app.include_router(events_router)
app.include_router(geofence_router)
app.include_router(medication_router)
app.include_router(reminders_router)
app.include_router(device_router)
app.include_router(speak_router)
app.include_router(chat_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
