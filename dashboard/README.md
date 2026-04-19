# Clarity Lite Caregiver Dashboard (Next.js)

Web dashboard for caregivers to manage Clarity Lite:

- Family photo references for face recognition
- Safe zone (geofence) configuration
- Medication schedules with bottle reference images
- Real-time event log
- Real-time conversation transcript (patient and Clarity)

## 1. Requirements

- Node.js 20+
- Backend running on MacBook over Tailscale
- Supabase project with required tables and storage buckets (`face-references`, `medication-references`)

## 2. Setup

```bash
cd dashboard
cp .env.example .env
npm install
```

Populate `.env`:

- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key
- `SUPABASE_SERVICE_KEY`: Supabase service role key (server-side only)
- `NEXT_PUBLIC_BACKEND_URL`: backend URL over Tailscale, example `http://100.x.x.x:8000`
- `BACKEND_URL` (optional): server-only override for API routes

## 3. Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## 4. Tab Behavior

- Family Photos:
  - Uploads photo to Supabase Storage bucket `face-references`
  - Inserts metadata into `face_references`
  - Calls backend `POST /sync-faces`
- Safe Zone:
  - Click map to set center
  - Radius slider from 50 to 500 meters
  - Saves via backend `POST /geofence`
- Reminders:
  - Uploads medication bottle photo to `medication-references` storage bucket
  - Creates schedule via backend `POST /reminders` with medication metadata
  - Lists schedules through `/api/reminders` (includes signed reference image URLs)
  - Backend uses this metadata during `/medication/verify` checks to confirm correct bottle at due time
  - Deletes reminders via backend `DELETE /reminders/{id}`
- Live Log:
  - Initial load from `/api/events?limit=100`
  - Subscribes to Supabase Realtime `events` INSERT feed
  - Prepends newest events and keeps max 100 rows
  - Prominent geofence breach alert banner appears in real time with acknowledge action
- Conversation:
  - Initial load from `/api/conversations?limit=300`
  - Subscribes to Supabase Realtime `conversations` INSERT feed
  - Displays newest chat turns at bottom (patient on right, Clarity on left)
  - Shows wake-word status line based on `wake_word_detected` events

## 5. Notes

- No dashboard authentication is implemented intentionally for demo scope.
- Keep dashboard private on the tailnet only; do not expose to public internet.

## 3D Room Viewer Medication Pin

The medication waypoint is hardcoded and locked in the viewer:

`x: 2.834, y: -1.579, z: 1.159`

It cannot be moved from the dashboard UI.

To validate flythrough behavior, trigger a `pill_bottle_check` event with `result=correct` and confirm the camera moves to the hardcoded medication anchor.
