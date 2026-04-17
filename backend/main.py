from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from routers.device import router as device_router
from routers.events import router as events_router
from routers.face import router as face_router
from routers.geofence import router as geofence_router
from routers.object import router as object_router
from routers.reminders import router as reminders_router
from scheduler import shutdown_scheduler, start_scheduler


load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    shutdown_scheduler()


app = FastAPI(title="Clarity Lite Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(object_router)
app.include_router(face_router)
app.include_router(events_router)
app.include_router(geofence_router)
app.include_router(reminders_router)
app.include_router(device_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
