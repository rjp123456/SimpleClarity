# Clarity Lite Backend

FastAPI backend for Clarity Lite.

## Requirements

- Python 3.11+
- Virtual environment

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Computer Vision Setup

1. Train the custom YOLOv11 model on Roboflow with five classes: `rj`, `mayank`, `harshal`, `orange_bottle`, `white_bottle`
2. Download the trained weights as `best.pt` from Roboflow
3. Place the file at `/backend/models/best.pt`
4. Set `CUSTOM_MODEL_PATH=./models/best.pt` in `.env`
   - Optional: set `OVERLAY_CONFIDENCE_THRESHOLD=0.25` to make bounding boxes easier to surface while keeping alerts stricter.
   - Optional: set `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` to enable backend-generated speech audio.
   - Optional: set `GEMINI_API_KEY` + `OPENWAKEWORD_MODEL_PATH` to enable voice chat + wake word.
5. Run `python scripts/test_detector.py` to validate before starting the server
6. Start the server normally — the model loads automatically on startup

## Wake Word Setup

Install wake-word and Gemini dependencies:

```bash
brew install portaudio
pip install -r requirements.txt
```

Set these in `.env`:

- `GEMINI_API_KEY` from Google AI Studio (`aistudio.google.com`)
- `GEMINI_MODEL` (recommended `gemini-2.5-flash-lite`)
- `OPENWAKEWORD_MODEL_PATH` pointing to your `hey_clarity.onnx` model
- `WAKE_WORD_ENABLED=true` only when wake-word assets are installed
- `ELEVENLABS_API_KEY` for STT/TTS
- `ELEVENLABS_VOICE_ID` for voice playback

Create this table in Supabase and enable Realtime replication on it:

```sql
create table conversations (
    id uuid primary key default gen_random_uuid(),
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    created_at timestamptz default now()
);
```

## Run

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## API Endpoints

- `GET /health`
- `POST /detect-live` (multipart `image`)
- `POST /speak` (JSON `{ "text": "..." }` -> `audio/mpeg` or JSON fallback)
- `POST /chat` (multipart `audio` -> `audio/mpeg` response when TTS succeeds)
- `POST /chat-text` (JSON `{ "text": "..." }` -> JSON response for chat debugging)
- `POST /identify-face` (multipart `image`)
- `POST /identify-pill-bottle` (multipart `image`)
- `GET /medication/due`
- `POST /medication/verify` (multipart `image`)
- `POST /device-token`
- `POST /events`
- `GET /events?limit=100`
- `GET /geofence`
- `POST /geofence`
- `GET /geofence/location`
- `POST /geofence/location`
- `POST /geofence/breach`
- `GET /reminders`
- `POST /reminders`
- `DELETE /reminders/{reminder_id}`
