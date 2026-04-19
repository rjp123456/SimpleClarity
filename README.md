# Clarity

Clarity is a dementia-assistance app built for a hackathon. It consists of:

- **iPhone app** (Expo Go) — the patient-facing interface worn on a lanyard
- **FastAPI backend** (MacBook M5) — local AI inference, scheduling, and event logging
- **Next.js dashboard** — caregiver web interface

The iPhone communicates with the backend over **Tailscale** private networking, so no public cloud infrastructure is required.

---

## What It Does

**For the patient (iPhone app)**
- Continuous live camera view with bounding-box overlays for detected people and medication bottles
- Voice assistant ("Clarity") powered by Gemini — the patient can speak naturally and receive spoken responses via ElevenLabs TTS
- Face recognition: when a family member is detected, the app speaks their name aloud
- Medication verification: when a reminder fires, the patient holds their bottle up to the camera; the app confirms whether it's the correct bottle and logs the intake
- GPS geofencing: if the patient leaves the safe zone, the app speaks a calm alert and notifies the caregiver dashboard
- "Hey Clarity" wake word (optional, backend-side) triggers the voice assistant hands-free

**For the caregiver (dashboard)**
- **Family tab** — upload labeled reference photos; triggers face-index sync on the backend
- **Safe Zone tab** — interactive map to set geofence center and radius; shows the patient's live GPS position and fires a breach alert automatically
- **Reminders tab** — create and delete medication reminders (label, time, days); shows current medication due status
- **Room tab** — 3D patient environment view with live pill-detection state
- **Live Log tab** — real-time event feed via Supabase Realtime (face identified, medication taken, geofence breach, reminder fired)

**AI and inference (all local or free-tier)**
- Custom YOLOv8 model (`models/best.pt`) trained on the specific people and bottle types for this demo
- Gemini API (free tier) for conversational AI responses
- ElevenLabs for TTS and speech-to-text
- No paid object detection or face recognition APIs

---

## Repository Layout

```
app/        Expo React Native patient app
backend/    FastAPI server — AI inference, scheduling, events
dashboard/  Next.js caregiver dashboard
shared/     Supabase schema SQL
```

---

## Prerequisites

- Node.js 20 or 22 LTS (Node 25 breaks Expo Metro)
- Python 3.11+
- iPhone with Expo Go and Tailscale installed
- MacBook with Tailscale installed
- Supabase project (free tier)
- Gemini API key (free tier)
- ElevenLabs API key (free tier)

---

## 1 — Supabase Setup

1. Run `shared/supabase_schema.sql` in the Supabase SQL Editor.
2. Create storage buckets: `face-references` and `medication-references`.
3. Enable Realtime on the `events` table: **Database → Replication → events**.

---

## 2 — Backend Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in values
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Required `backend/.env` variables**

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL` | Model name (default: `gemini-2.0-flash-lite`) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID |
| `CUSTOM_MODEL_PATH` | Path to YOLO model (default: `./models/best.pt`) |
| `DETECTION_CONFIDENCE_THRESHOLD` | Alert confidence threshold (default: `0.55`) |
| `OVERLAY_CONFIDENCE_THRESHOLD` | Overlay box threshold (default: `0.30`) |
| `TAILSCALE_IP` | MacBook's Tailscale IP (for reference) |
| `SCHEDULER_TIMEZONE` | e.g. `America/Chicago` |
| `RESEND_API_KEY` | (Optional) Resend key for breach email alerts |
| `CAREGIVER_EMAIL` | (Optional) Email for breach alerts |
| `WAKE_WORD_ENABLED` | `true` to enable "Hey Clarity" wake word (default: `false`) |

---

## 3 — Dashboard Setup

```bash
cd dashboard
cp .env.example .env   # then fill in values
npm install
npm run dev
```

**Required `dashboard/.env` variables**

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `NEXT_PUBLIC_BACKEND_URL` | Backend URL, e.g. `http://100.x.x.x:8000` |

---

## 4 — App Setup

```bash
cd app
cp .env.example .env   # then fill in values
npm install
npm run start
```

Scan the Expo QR code from the iPhone Expo Go app.

**Required `app/.env` variables**

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_BACKEND_URL` | Backend URL, e.g. `http://100.x.x.x:8000` |
| `EXPO_PUBLIC_SUPABASE_URL` | (Optional) Supabase URL for wake-word realtime |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | (Optional) Supabase anon key |

---

## 5 — Demo Test Script

1. **Health check** — `GET /health` returns `{ "status": "ok" }`.
2. **Face recognition** — Point the phone at a registered face; confirm the name is spoken aloud and a `face_identified` event appears in the Live Log.
3. **Medication reminder** — Add a reminder due in 2 minutes. When it fires, hold the correct (orange) bottle up to the camera; confirm spoken confirmation and `medication_taken` event.
4. **Geofence** — Set a small safe zone radius. Walk outside it; confirm the dashboard breach popup and `geofence_breach` event.
5. **Voice chat** — Tap the mic button and ask a question; confirm a spoken Gemini response.
6. **Family upload** — Upload a new reference photo from the dashboard; confirm face sync and detection on the phone.

---

## Notes

- The dashboard has no authentication — it is only accessible over Tailscale.
- The backend and dashboard run on the same MacBook; both must be running for the demo.
- The Tailscale IP is static within the tailnet. Find it with `tailscale ip -4`.
- On first launch, the YOLO model is already bundled at `backend/models/best.pt`. DeepFace is not used — face recognition runs through the same YOLO model.
