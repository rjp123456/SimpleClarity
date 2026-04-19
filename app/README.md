# Clarity Lite iPhone App (Expo Go)

Patient-facing iPhone app for Clarity Lite.  
The app keeps the camera active full-screen, sends frames to `POST /detect-live`, draws live bounding boxes, shows top notification banners, and speaks only on positive detections with cooldown protection.
Speech is requested from backend `POST /speak` (ElevenLabs), with automatic device-TTS fallback when unavailable.

## 1. Requirements

- Node.js 20 or 22 LTS (do not use Node 25 with Expo CLI)
- iPhone with Expo Go installed
- Backend running and reachable from iPhone (LAN IP or Tailscale IP)

## 2. Setup

```bash
cd app
cp .env.example .env
npm install
```

Set `.env`:

- `EXPO_PUBLIC_BACKEND_URL`: Full backend URL including port, for example `http://100.x.x.x:8000`
- `EXPO_PUBLIC_EAS_PROJECT_ID` (optional): Helps push token registration in some Expo setups

## 3. Run

```bash
npm run start
```

Open the project in Expo Go on iPhone (scan the QR code).

Alternative startup modes:

```bash
npm run start:lan
npm run start:tunnel
```

## 4. Features Implemented

- Always-on camera experience:
  - Calls `POST /detect-live` on a fast interval (~800ms) with single in-flight request protection.
  - Camera preview is full-screen with overlay rendering for detections.
- Speech logic:
  - Speaks only for positive `primary_alert` responses from `/detect-live`.
  - Uses change + cooldown behavior to avoid repeated speech spam.
  - Uses per-alert cooldown keys from backend (`face_*`, `pill_ok`, `pill_wrong`).
- Silent on negative results:
  - No speech for `none` alerts, network errors, unchanged alert state, or cooldown hits.

## 5. Troubleshooting

- If camera/location prompts were denied, open iOS Settings and re-enable permissions.
- If Expo Go times out while opening the app:
  - Start with `npm run start:tunnel` and scan the new QR code.
  - On iPhone, open `http://<your_mac_ip>:8081/status` in Safari. It should return `packager-status:running`.
  - Ensure Expo Go has iOS Local Network permission enabled (Settings -> Expo Go -> Local Network).
  - Ensure Mac firewall allows incoming connections for Node/Terminal.
  - Ensure iPhone and Mac are on the same non-guest Wi-Fi network (guest networks often block peer traffic).
- If network calls fail, verify:
  - `EXPO_PUBLIC_BACKEND_URL` uses a reachable backend IP and port `8000`.
  - On iPhone Safari, `http://<backend_ip>:8000/health` returns `{"status":"ok"}`.
  - Backend runs with `--host 0.0.0.0`.
- If reminders are not spoken in foreground, verify iOS notification permissions are enabled.
