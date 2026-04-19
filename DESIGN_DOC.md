Project overview
You are building Clarity Lite, a dementia patient assistant application. It consists of two parts: an iPhone app built with Expo Go (React Native), and a backend server running on a MacBook M1. The two communicate over Tailscale, a peer-to-peer VPN that gives the iPhone a stable private IP address to reach the MacBook regardless of what network either device is on.
The patient wears their iPhone on a lanyard around their neck. A Siri Shortcut opens the app and triggers a camera capture. The app photographs whatever is in front of the patient, sends the frame to the backend, receives a text response, and reads it aloud using the device's text-to-speech. The app also monitors the patient's GPS location and fires an alert if they leave a predefined safe zone. Scheduled medication reminders fire as local notifications and are read aloud automatically.
A caregiver manages everything through a Next.js web dashboard running on the same MacBook. The dashboard is the caregiver's primary interface: they upload labeled family photos for face recognition, configure the geofence safe zone, schedule medication reminders, and monitor a live event log that updates in real time.
Nothing in this project requires paid AI API usage. Object recognition runs through a local YOLOv8n model, face recognition runs locally via DeepFace (open source Python library, no API), the database is Supabase free tier, and email alerts use Resend free tier.

Repository structure
Organize the project as a monorepo with the following top-level directories:
/app — the Expo React Native iPhone application
/backend — the FastAPI Python server
/dashboard — the Next.js caregiver web application
/shared — any shared types, constants, or utility functions referenced by both app and dashboard
Each directory is an independently runnable project with its own dependency file. Do not couple them at the import level. They communicate exclusively over HTTP.

Environment variables
All secrets and configuration live in .env files. Never hardcode them. The backend reads from /backend/.env. The dashboard reads from /dashboard/.env. The app reads from /app/.env via expo-constants.
Required backend environment variables:

SUPABASE_URL — your Supabase project URL
SUPABASE_SERVICE_KEY — Supabase service role key (not the anon key — this runs server-side)
YOLO_MODEL_PATH — YOLO model path or model name (default yolov8n.pt)
YOLO_CONFIDENCE — detection confidence threshold between 0 and 1 (default 0.35)
YOLO_DEVICE — optional Ultralytics device override (cpu, mps, 0)
RESEND_API_KEY — Resend API key for caregiver email alerts
CAREGIVER_EMAIL — the email address that receives geofence breach alerts
TAILSCALE_IP — the MacBook's Tailscale IP (used for documentation/reference, not read at runtime)

Required app environment variables:

EXPO_PUBLIC_BACKEND_URL — full URL of the backend including port, e.g. http://100.x.x.x:8000. This is the Tailscale IP of the MacBook.

Required dashboard environment variables:

NEXT_PUBLIC_SUPABASE_URL — same as above
NEXT_PUBLIC_SUPABASE_ANON_KEY — Supabase anon key (safe to expose in frontend)
SUPABASE_SERVICE_KEY — used in Next.js API routes for privileged operations
RESEND_API_KEY — for sending emails from dashboard API routes if needed

Backend — FastAPI
Runtime and dependencies
Python 3.11 or later. Use a virtual environment. Key dependencies: fastapi, uvicorn, python-multipart, deepface, tf-keras, apscheduler, supabase-py, httpx, resend, python-dotenv, pillow.
Run the server with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
The --host 0.0.0.0 flag is mandatory. Without it, the server only listens on localhost and Tailscale traffic cannot reach it.
File structure inside /backend
main.py — FastAPI app instantiation, router registration, CORS configuration, APScheduler startup
routers/face.py — face recognition endpoint
routers/object.py — object recognition endpoint
routers/geofence.py — geofence configuration and breach handling
routers/reminders.py — reminder CRUD and scheduler management
routers/events.py — event log write endpoint
services/deepface_service.py — DeepFace initialization, face indexing, face matching logic
services/yolo_service.py — local YOLOv8 object detection inference service
services/supabase_service.py — Supabase client initialization and helper functions
services/resend_service.py — email sending via Resend
scheduler.py — APScheduler instance and job registration logic
models.py — Pydantic request and response models for all endpoints
CORS configuration
Allow all origins during development. In main.py, configure CORSMiddleware with allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]. This is intentional for a hackathon demo running on a private Tailscale network.
Endpoint: POST /identify-face
Accepts a multipart form upload with a single field named image containing a JPEG image file.
Processing: save the incoming image to a temporary file, call DeepFace find() against the reference database directory, clean up the temp file, return a JSON response.
Response shape on match: { "matched": true, "name": "Sarah", "relationship": "daughter", "confidence": 0.87 }
Response shape on no match: { "matched": false }
Response shape on error: { "matched": false, "error": "description" }
After responding, write an event to Supabase asynchronously: event type face_identified, payload includes name, relationship, confidence, and timestamp.
The DeepFace reference database is a directory on the MacBook at a path configured via environment variable DEEPFACE_DB_PATH. This directory contains subdirectories named by person, each containing one or more JPEG photos. Example structure: db/sarah_daughter/photo1.jpg, db/mom_wife/photo1.jpg. DeepFace find() searches this directory tree automatically.
Endpoint: POST /identify-object
Accepts a multipart form upload with a single field named image containing a JPEG image file.
Processing: run local YOLOv8n object detection on the uploaded image, filter detections to medically or practically relevant objects, and return a short calm text response.
If no relevant objects are detected, return a brief fallback response.
Response shape: { "description": "Those are your blood pressure pills. They should be taken once a day with water." }
After responding, write an event to Supabase: event type object_identified, payload includes the description and timestamp.
Endpoint: GET /geofence
Returns the currently configured geofence from Supabase. Response shape: { "latitude": 30.2672, "longitude": -97.7431, "radius_meters": 200 }
If no geofence is configured, return { "configured": false }.
Endpoint: POST /geofence
Accepts JSON body: { "latitude": float, "longitude": float, "radius_meters": int }. Upserts this configuration into Supabase. Returns the saved config.
Endpoint: POST /geofence/breach
Called by the iPhone app when it detects a geofence breach. Accepts JSON body: { "latitude": float, "longitude": float, "timestamp": string }.
Processing: send an email via Resend to the CAREGIVER_EMAIL address with subject "Clarity Alert: Patient has left the safe zone" and a body that includes the timestamp and approximate location. Write an event to Supabase: event type geofence_breach.
Response: { "alerted": true }
Endpoint: GET /reminders
Returns all configured reminders from Supabase as an array. Each reminder has: { "id": uuid, "label": string, "time": "HH:MM", "days": ["mon","tue",...], "active": bool }
Endpoint: POST /reminders
Accepts a reminder object without id. Saves to Supabase, registers a cron job in APScheduler, returns the created reminder with its generated id.
Endpoint: DELETE /reminders/{id}
Removes the reminder from Supabase and cancels the APScheduler job with matching id.
Endpoint: POST /events
Accepts { "type": string, "payload": object }. Writes directly to the Supabase events table. Used by the iPhone app to log geofence breaches and other client-side events.
APScheduler setup
Use BackgroundScheduler from APScheduler. Start it in a FastAPI startup event handler. On startup, load all active reminders from Supabase and register them as CronTrigger jobs. Each job's function calls the Supabase events table to log the reminder firing, and also calls the Expo Push Notifications API if a push token is stored. For the demo, logging to Supabase is sufficient — the dashboard event log will reflect it in real time.
DeepFace setup
Import DeepFace at module load time. On first call to /identify-face, DeepFace will build a representation database from the photos in DEEPFACE_DB_PATH. This takes 5–15 seconds on first run and is cached automatically by DeepFace in a pickle file inside the same directory. Subsequent calls are fast (under 1 second on M1). Use model ArcFace and detector backend retinaface for best accuracy. Set enforce_detection=False so poor-angle photos don't throw exceptions — they simply return no match.
Supabase schema
Four tables are required. Create them via the Supabase dashboard SQL editor before running the backend.
Table events: columns id (uuid, primary key, default gen_random_uuid()), type (text, not null), payload (jsonb), created_at (timestamptz, default now()).
Table geofence_config: columns id (int, primary key, default 1 — only one row ever exists), latitude (float8), longitude (float8), radius_meters (int), updated_at (timestamptz, default now()).
Table reminders: columns id (uuid, primary key, default gen_random_uuid()), label (text), time (text — stored as "HH:MM"), days (text array), active (bool, default true), created_at (timestamptz, default now()).
Table face_references: columns id (uuid, primary key), name (text), relationship (text), photo_path (text), created_at (timestamptz, default now()). This table is metadata only — the actual images live on disk in DEEPFACE_DB_PATH. The dashboard writes to this table when uploading a photo so it can display the reference set.
Enable Supabase Realtime on the events table. This is done in the Supabase dashboard under Database → Replication → enable events table. The dashboard subscribes to this channel to power the live event log.

iPhone app — Expo Go
Runtime and dependencies
Node 18 or later. Initialize with npx create-expo-app@latest app --template blank. Key dependencies: expo-camera, expo-location, expo-speech, expo-notifications, expo-constants, axios, @react-navigation/native, @react-navigation/stack, expo-linear-gradient.
All dependencies must be compatible with Expo Go. Do not install any library that requires native modules outside Expo's managed workflow. Before adding any dependency, verify it appears in the Expo SDK compatibility list.
Screen structure
The app has two screens managed by a stack navigator.
HomeScreen — the patient-facing interface. This is what the patient sees and interacts with.
SettingsScreen — accessible via a small gear icon in the top corner. Allows changing the backend URL in case the Tailscale IP changes. Not meant for the patient to use.
HomeScreen design
The screen must be simple, high-contrast, and large. Assume the patient has reduced fine motor control and mild visual impairment.
The screen has two large buttons centered vertically: "Who is this?" and "What is this?". Each button takes up roughly 40% of the screen width and 20% of the screen height. Font size on buttons is at minimum 24px. The buttons should be clearly distinct in color.
Below the buttons, a small status text area shows the last response received from the backend. This text should also be large (18px minimum) and read-only.
At the top of the screen, a small unobtrusive indicator shows whether the backend is reachable (green dot) or not (red dot). This pings GET /health on the backend every 30 seconds.
There is no camera preview visible to the patient. The camera operates silently in the background. When a button is pressed, the phone captures a frame and submits it — the patient does not need to frame anything deliberately.
Camera behavior
Use expo-camera with the back-facing camera. Request camera permission on app first launch with a clear explanation dialog. Keep a camera reference mounted but invisible — use a Camera component with zero opacity or dimensions of 1x1 positioned off-screen. This keeps the camera ready without showing a preview.
When either recognition button is pressed: call camera.takePictureAsync({ quality: 0.7, base64: false }) to get a URI, convert the URI to a blob using fetch, construct a FormData object with the field name image, and POST it to the appropriate backend endpoint. While waiting for the response, show a loading indicator and disable both buttons to prevent double-submission. On response, call Speech.speak(responseText) and display the text in the status area. Re-enable buttons after speech begins.
Do not send frames continuously. Do not keep a video stream running. One button press equals one frame capture equals one backend call.
Siri Shortcut integration
Use Expo's deep linking support. Register a custom URL scheme in app.json: clarity://identify-face and clarity://identify-object. When the app receives a deep link on either of these URLs, it should automatically trigger the corresponding capture-and-identify flow as if the user had pressed the button.
The Siri Shortcut is configured manually on the patient's iPhone once during setup: open Shortcuts app, create a new shortcut, add action "Open URL", enter clarity://identify-face, add action "Open App" pointing to Clarity. Name it something simple like "Who is this". The patient can then say "Hey Siri, who is this" to trigger the flow hands-free.
Document this setup process clearly in the project README.
Geofencing
Request location permission on first launch with explanation. Request "Always" location access — this is required for background geofencing. On app start, fetch the geofence config from GET /geofence. If configured, register it using expo-location's startGeofencingAsync.
When a geofence exit event fires (the patient leaves the safe zone): call Speech.speak("You are leaving the safe area. Please turn around and go home."), then POST to /geofence/breach with the current coordinates and timestamp.
If the geofence config returns { configured: false }, skip registration silently. The app will retry on next launch.
Medication reminders
On app launch, request notification permission. Reminders are scheduled server-side via APScheduler — the backend fires the notification using Expo's Push Notification service if a push token is available, or simply logs to Supabase if not. For the demo, the reminder firing is visible in the dashboard event log.
Store the device's Expo Push Token by POSTing it to a POST /device-token endpoint on the backend on each app launch. The backend stores this in a simple config table. When APScheduler fires a reminder, it uses this token to send a push notification via https://exp.host/--/api/v2/push/send.
When a local notification is received while the app is in the foreground, intercept it with a notification listener and call Speech.speak(notificationBody) immediately.
Error handling
All backend calls are wrapped in try-catch. On network error, display "Cannot reach server. Please check your connection." in the status area and speak it aloud. Never show a raw error message or stack trace on the patient-facing screen. Log errors to console for debugging only.

Caregiver dashboard — Next.js
Runtime and dependencies
Node 18 or later. Initialize with npx create-next-app@latest dashboard. Use the App Router. Key dependencies: @supabase/supabase-js, @supabase/ssr, leaflet, react-leaflet, resend (in API routes only).
Page structure
The dashboard is a single-page application with four tab sections accessible via a top navigation bar. No authentication is required for the hackathon demo — the dashboard is only accessible over Tailscale.
Tab 1: Family photos — upload and manage reference photos for face recognition
Tab 2: Safe zone — configure the geofence on an interactive map
Tab 3: Reminders — create and delete medication reminders
Tab 4: Live log — real-time event feed
Tab 1 — Family photos
Displays a grid of currently registered family members. Each card shows the person's name, relationship, and their reference photo.
Upload form: two text inputs (Name, Relationship) and a file input accepting JPEG/PNG. On submit, the photo is uploaded to Supabase Storage in a bucket called face-references, in a path like {name}\_{relationship}/{filename}. After upload, a record is inserted into the face_references table. A Next.js API route then calls the backend POST /sync-faces endpoint which triggers DeepFace to rebuild its reference index from the updated directory.
The backend must also expose a POST /sync-faces endpoint that re-scans DEEPFACE_DB_PATH and rebuilds the DeepFace representation cache. This is called automatically after each photo upload.
Photos stored in Supabase Storage must also be downloaded to the local DEEPFACE_DB_PATH directory on the MacBook for DeepFace to use them. The /sync-faces endpoint handles this: it queries the face_references table, downloads any photos not already present in the local directory using the Supabase Storage URL, and saves them into the correct subdirectory structure.
Tab 2 — Safe zone
A full-width interactive map using React Leaflet. The map centers on Austin, Texas by default. If a geofence is already configured, it displays as a circle on the map.
The caregiver can click anywhere on the map to set a new center point. A radius slider below the map adjusts the safe zone radius from 50 to 500 meters. A "Save safe zone" button POSTs the new configuration to the backend POST /geofence endpoint.
Below the map, display the current configured coordinates and radius in plain text for reference.
Tab 3 — Reminders
A list of currently configured reminders, each showing label, time, and active days. Each reminder has a delete button.
An "Add reminder" form with three fields: label (text, e.g. "Take blood pressure pill"), time (time picker), and days (multi-select checkboxes for each day of the week). On submit, POST to backend POST /reminders. The list updates immediately.
Tab 4 — Live log
A vertically scrolling list of events, newest at the top. Each event shows its type as a colored badge, the timestamp, and relevant payload details rendered in plain English.
Event type display rules: face_identified → green badge, shows "Recognized: {name} ({relationship})". object_identified → blue badge, shows the description truncated to 80 characters. geofence_breach → red badge, shows "Patient left safe zone". reminder_fired → amber badge, shows the reminder label.
This list is powered by Supabase Realtime. On component mount, subscribe to the events table INSERT channel. When a new row arrives, prepend it to the list without a full page reload. The list should display a maximum of 100 events — older ones fall off the bottom.

Networking and Tailscale
The MacBook M1 has Tailscale installed. Its Tailscale IP is static within the tailnet and does not change between sessions. Find it by running tailscale ip -4 in the terminal.
The iPhone must have the Tailscale iOS app installed and be logged into the same Tailscale account. Once both devices are on the same tailnet, the iPhone can reach the MacBook at its Tailscale IP on any port without any additional configuration.
The backend runs on port 8000. The dashboard runs on port 3000. Both are accessible from any device on the tailnet.
The EXPO_PUBLIC_BACKEND_URL in the app's .env must be set to http://{tailscale_ip}:8000 before running the app. If the Tailscale IP ever changes (it shouldn't), update this value and restart the Expo dev server.

Build order — implement in this exact sequence
Do not skip ahead. Each step depends on the previous one working.
Step 1: Backend skeleton. Create the FastAPI app with a single GET /health endpoint returning { "status": "ok" }. Confirm it starts and is reachable at http://0.0.0.0:8000/health from the terminal on the MacBook.
Step 2: App skeleton. Initialize the Expo project. Build the HomeScreen with two placeholder buttons. Confirm it runs in Expo Go on the iPhone. Confirm the iPhone can reach the backend health endpoint by making an axios GET to EXPO_PUBLIC_BACKEND_URL/health and logging the response.
Step 3: Camera integration. Add the invisible camera component to HomeScreen. Wire the "What is this?" button to take a picture and log the resulting URI to console. Confirm the URI is valid and the image file exists.
Step 4: Object recognition endpoint. Implement POST /identify-object on the backend. Wire the app to POST the captured frame to this endpoint and receive a text response. Call Speech.speak() with the response. Confirm the full flow works end-to-end: button press → frame → backend → YOLOv8n → spoken response.
Step 5: DeepFace setup. Install DeepFace on the MacBook. Create the reference database directory. Add one photo of yourself manually into a subdirectory. Implement POST /identify-face on the backend. Wire the app's "Who is this?" button to this endpoint. Confirm it returns your name when you point the phone at your face.
Step 6: Supabase setup. Create the four tables in Supabase. Confirm the backend can read and write to all four. Add event logging to both recognition endpoints.
Step 7: Geofencing. Implement the geofence endpoints on the backend. Implement geofence registration in the app. Test by setting a very small radius (10 meters) and walking away from it.
Step 8: Reminders. Implement the reminders endpoints and APScheduler jobs. Implement push token registration in the app. Test by creating a reminder 2 minutes in the future.
Step 9: Dashboard. Build the Next.js dashboard with all four tabs. Wire photo upload to the backend sync endpoint. Wire geofence config to the backend. Wire reminders to the backend. Confirm the live log updates in real time via Supabase Realtime.
Step 10: Integration testing. Run the full demo script end-to-end. Fix any broken seams. Polish voice response text.

Code quality rules
Never hardcode secrets, IPs, or configuration values in source files. All configuration comes from environment variables.
Never show technical error messages to the patient on the HomeScreen. All patient-facing error text must be in plain, calm English.
All backend endpoints must return consistent JSON shapes. Use Pydantic models for all request and response bodies.
All async operations in the app must handle loading state — disable buttons while a request is in flight, show a spinner, re-enable on completion or error.
The dashboard does not need authentication for this demo but must not be exposed to the public internet. It is only accessible over Tailscale.
Write a brief README in each subdirectory documenting how to install, configure, and run that component. Include the required environment variables and their descriptions.

What not to build
Do not build continuous video streaming from the phone to the backend. Snapshot on demand only.
Do not build a login or authentication system for the dashboard.
Do not build a mobile app for the caregiver. The dashboard is web-only.
Do not attempt to run DeepFace on the iPhone or in the browser. It runs only on the MacBook backend.
Do not use any paid APIs or services beyond what is listed. If you need an API not listed here, flag it and propose a free alternative.
Do not build any feature not listed in this document without explicit instruction.
