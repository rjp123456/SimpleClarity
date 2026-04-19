import logging
import os
import time
from typing import Any

from services.supabase_service import get_client, supabase_is_configured

logger = logging.getLogger(__name__)

OPENWAKEWORD_MODEL_PATH = os.getenv(
    "OPENWAKEWORD_MODEL_PATH",
    "./models/hey_clarity.onnx",
).strip()
WAKE_WORD_ENABLED = os.getenv("WAKE_WORD_ENABLED", "false").strip().lower() == "true"
CHUNK_SIZE = 1280
SAMPLE_RATE = 16000
DETECTION_THRESHOLD = 0.5
COOLDOWN_SECONDS = 2.4


def _extract_score(prediction: Any) -> float:
    best_score = 0.0
    if isinstance(prediction, dict):
        for value in prediction.values():
            if isinstance(value, (int, float)):
                best_score = max(best_score, float(value))
                continue
            if hasattr(value, "__len__") and len(value):  # numpy array / list
                last_value = value[-1]
                if isinstance(last_value, (int, float)):
                    best_score = max(best_score, float(last_value))
                    continue
                if hasattr(last_value, "__len__") and len(last_value):
                    # Handles nested arrays such as [[0.1, 0.8]]
                    best_score = max(
                        best_score,
                        max(float(entry) for entry in last_value),
                    )
    return best_score


def emit_wake_event() -> None:
    if not supabase_is_configured():
        return
    try:
        client = get_client()
        client.table("events").insert(
            {
                "type": "wake_word_detected",
                "payload": {"phrase": "hey_clarity"},
            }
        ).execute()
        logger.info("Wake word detected - event emitted")
    except Exception as exc:
        logger.warning("Wake event emit error: %s", exc)


def run_wake_word_listener() -> None:
    if not WAKE_WORD_ENABLED:
        logger.info("Wake word detection disabled (WAKE_WORD_ENABLED=false)")
        return

    try:
        import numpy as np
        import pyaudio
        from openwakeword.model import Model
    except Exception as exc:
        logger.warning("Wake word dependencies unavailable: %s — detection disabled", exc)
        return

    if not os.path.exists(OPENWAKEWORD_MODEL_PATH):
        logger.warning("Wake word model not found at %s — detection disabled", OPENWAKEWORD_MODEL_PATH)
        return

    logger.info("Loading OpenWakeWord model...")
    try:
        wake_model = Model(
            wakeword_models=[OPENWAKEWORD_MODEL_PATH],
            inference_framework="onnx",
        )
    except Exception as exc:
        logger.exception("Failed to load wake word model: %s", exc)
        return

    audio = pyaudio.PyAudio()
    stream = None
    try:
        stream = audio.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_SIZE,
        )
        logger.info("Wake word listener active — say 'Hey Clarity'")
        next_allowed_detection_at = 0.0
        while True:
            audio_chunk = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            audio_array = np.frombuffer(audio_chunk, dtype=np.int16)
            prediction = wake_model.predict(audio_array)
            current_score = _extract_score(prediction)
            now = time.time()
            if current_score >= DETECTION_THRESHOLD and now >= next_allowed_detection_at:
                emit_wake_event()
                next_allowed_detection_at = now + COOLDOWN_SECONDS
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        logger.exception("Wake word listener runtime error: %s", exc)
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        try:
            audio.terminate()
        except Exception:
            pass
