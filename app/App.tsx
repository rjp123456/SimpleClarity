import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MaterialIcons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { startRecording, stopRecording } from "./utils/audioRecorder";
import { sendAudioToChat } from "./utils/chatApi";
import { speak } from "./utils/speak";

type Detection = {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  bbox_normalized?: [number, number, number, number];
};

type PrimaryAlert = {
  type: "face" | "pill_ok" | "pill_wrong" | "none";
  text: string;
  speak_text: string;
  severity: "info" | "success" | "danger";
  cooldown_key: string;
};

type DetectLiveResponse = {
  detections: Detection[];
  image_size: {
    width: number;
    height: number;
  };
  person_detected: boolean;
  orange_bottle_detected: boolean;
  white_bottle_detected: boolean;
  primary_alert: PrimaryAlert;
};

type MedicationDueResponse = {
  due: boolean;
  intake_logged?: boolean;
  reminder_id?: string | null;
  reminder_label?: string | null;
  medication_name?: string | null;
  reminder_time?: string | null;
  due_key?: string | null;
  guidance?: string;
};

type MedicationVerifyResponse = {
  due: boolean;
  reminder_id?: string | null;
  reminder_label?: string | null;
  medication_name?: string | null;
  reminder_time?: string | null;
  due_key?: string | null;
  bottle_visible: boolean;
  correct_medication_visible: boolean;
  logged_intake: boolean;
  guidance: string;
  seen_label?: string | null;
};

type EventRecord = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type NotificationState = {
  text: string;
  severity: "info" | "success" | "danger";
};

type RenderedBox = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  color: string;
};

function getBackendUrl(): string {
  const configured =
    Constants.expoConfig?.extra?.backendUrl ||
    process.env.EXPO_PUBLIC_BACKEND_URL ||
    "";
  return String(configured).trim().replace(/\/+$/, "");
}

function getSupabaseConfig(): { url: string; anonKey: string } {
  const url = String(process.env.EXPO_PUBLIC_SUPABASE_URL || "").trim();
  const anonKey = String(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  return { url, anonKey };
}

const FACE_SPEECH_COOLDOWN_MS = 1200;
const PILL_SPEECH_COOLDOWN_MS = 0;
const SYSTEM_SPEECH_MIN_GAP_MS = 250;
const MEDICATION_VERIFY_INTERVAL_MS = 1000;
const ANALYZE_TICK_INTERVAL_MS = 600;
const REMINDER_EVENT_WINDOW_MS = 3 * 60 * 1000;
const CHAT_AUTO_STOP_MS = 8000;
const LOCATION_WATCH_TIME_INTERVAL_MS = 3000;
const LOCATION_WATCH_DISTANCE_METERS = 2;
const LOCATION_FALLBACK_PUSH_INTERVAL_MS = 6000;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});

const CLASS_LABELS: Record<string, string> = {
  mayank: "RJ - brother",
  harshal: "RJ - brother",
  rj: "RJ - brother",
  orange_bottle: "Orange Bottle (Correct)",
  white_bottle: "White Bottle (Incorrect)"
};

const CLASS_COLORS: Record<string, string> = {
  mayank: "#3B82F6",
  harshal: "#3B82F6",
  rj: "#3B82F6",
  orange_bottle: "#22C55E",
  white_bottle: "#EF4444"
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function projectDetectionToViewport(
  detection: Detection,
  frameSize: { width: number; height: number },
  viewportSize: { width: number; height: number }
): Omit<RenderedBox, "key" | "label" | "color"> | null {
  const viewWidth = viewportSize.width;
  const viewHeight = viewportSize.height;
  if (!viewWidth || !viewHeight) {
    return null;
  }

  let [x1n, y1n, x2n, y2n] = detection.bbox_normalized || [0, 0, 0, 0];
  if (!detection.bbox_normalized || detection.bbox_normalized.length !== 4) {
    const [x1, y1, x2, y2] = detection.bbox || [0, 0, 0, 0];
    if (!frameSize.width || !frameSize.height) {
      return null;
    }
    x1n = x1 / frameSize.width;
    y1n = y1 / frameSize.height;
    x2n = x2 / frameSize.width;
    y2n = y2 / frameSize.height;
  }

  x1n = clamp(x1n, 0, 1);
  y1n = clamp(y1n, 0, 1);
  x2n = clamp(x2n, 0, 1);
  y2n = clamp(y2n, 0, 1);

  // Fallback mapper: draw directly in viewport space from normalized bbox.
  // This keeps boxes visible even when capture orientation/crop metadata differs
  // from the camera preview's "cover" transform.
  const directLeft = clamp(x1n * viewWidth, 0, viewWidth);
  const directTop = clamp(y1n * viewHeight, 0, viewHeight);
  const directRight = clamp(x2n * viewWidth, 0, viewWidth);
  const directBottom = clamp(y2n * viewHeight, 0, viewHeight);
  const directWidth = directRight - directLeft;
  const directHeight = directBottom - directTop;

  const sourceAspect = frameSize.width && frameSize.height ? frameSize.width / frameSize.height : 0;
  const viewAspect = viewWidth / viewHeight;
  const aspectDelta = sourceAspect && viewAspect ? Math.abs(sourceAspect - viewAspect) : 0;

  const sourceWidth = frameSize.width || 1;
  const sourceHeight = frameSize.height || 1;
  const scale = Math.max(viewWidth / sourceWidth, viewHeight / sourceHeight);
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  const offsetX = (viewWidth - scaledWidth) / 2;
  const offsetY = (viewHeight - scaledHeight) / 2;

  const rawLeft = offsetX + x1n * scaledWidth;
  const rawTop = offsetY + y1n * scaledHeight;
  const rawRight = offsetX + x2n * scaledWidth;
  const rawBottom = offsetY + y2n * scaledHeight;

  const left = clamp(rawLeft, 0, viewWidth);
  const top = clamp(rawTop, 0, viewHeight);
  const right = clamp(rawRight, 0, viewWidth);
  const bottom = clamp(rawBottom, 0, viewHeight);
  const width = right - left;
  const height = bottom - top;

  if (width >= 6 && height >= 6 && aspectDelta <= 0.65) {
    return {
      left,
      top,
      width,
      height
    };
  }

  if (directWidth < 6 || directHeight < 6) {
    return null;
  }

  return {
    left: directLeft,
    top: directTop,
    width: directWidth,
    height: directHeight
  };
}

export default function App() {
  const backendUrl = useMemo(() => getBackendUrl(), []);
  const notificationTopInset = Math.max(Number(Constants.statusBarHeight || 0), 44) + 12;
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isConnected, setIsConnected] = useState(false);
  const [locationPermissionGranted, setLocationPermissionGranted] = useState<boolean | null>(null);
  const [notificationsPermissionGranted, setNotificationsPermissionGranted] = useState<boolean | null>(null);
  const [locationStatus, setLocationStatus] = useState("Loc: init");
  const [dueMedication, setDueMedication] = useState<MedicationDueResponse | null>(null);
  const [activeReminderText, setActiveReminderText] = useState("");
  const [lastDetectionText, setLastDetectionText] = useState("Looking around...");
  const [isListening, setIsListening] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [chatResponse, setChatResponse] = useState("");
  const [chatProcessing, setChatProcessing] = useState(false);

  const inFlightRef = useRef(false);
  const locationInFlightRef = useRef(false);
  const locationWatchRef = useRef<Location.LocationSubscription | null>(null);
  const medicationVerifyInFlightRef = useRef(false);
  const captureLockRef = useRef(false);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpokenAtRef = useRef<Record<string, number>>({});
  const lastSystemSpeechAtRef = useRef(0);
  const lastAlertSignatureRef = useRef("none");
  const chatPriorityUntilRef = useRef(0);
  const reminderAlertedDueKeyRef = useRef("");
  const medicationLoggedDueKeyRef = useRef("");
  const lastMedicationVerifyAtRef = useRef(0);
  const pushTokenRegisteredRef = useRef(false);
  const seenReminderEventIdsRef = useRef<Record<string, true>>({});
  const activeBannerRef = useRef<NotificationState | null>(null);
  const isListeningRef = useRef(false);
  const chatProcessingRef = useRef(false);
  const chatAutoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supabaseChannelRef = useRef<RealtimeChannel | null>(null);
  const [notification, setNotification] = useState<NotificationState | null>(null);
  const bannerAnim = useRef(new Animated.Value(0)).current;
  const micPulseAnim = useRef(new Animated.Value(1)).current;
  const micPulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const renderedBoxes = useMemo<RenderedBox[]>(() => {
    const results: RenderedBox[] = [];
    for (let index = 0; index < detections.length; index += 1) {
      const detection = detections[index];
      const projected = projectDetectionToViewport(detection, frameSize, viewportSize);
      if (!projected) {
        continue;
      }
      const className = String(detection.class || "").trim().toLowerCase();
      const labelBase = CLASS_LABELS[className] || className || "Unknown";
      results.push({
        key: `${className}-${index}`,
        label: labelBase,
        color: CLASS_COLORS[className] || "#E0E0E0",
        ...projected
      });
    }
    return results;
  }, [detections, frameSize, viewportSize]);

  const showNotification = (text: string, severity: NotificationState["severity"]) => {
    const next = { text, severity };
    const current = activeBannerRef.current;
    if (current && current.text === next.text && current.severity === next.severity) {
      return;
    }

    activeBannerRef.current = next;
    setNotification(next);

    if (hideBannerTimerRef.current) {
      clearTimeout(hideBannerTimerRef.current);
      hideBannerTimerRef.current = null;
    }

    bannerAnim.stopAnimation();
    bannerAnim.setValue(0);
    Animated.timing(bannerAnim, {
      toValue: 1,
      duration: 120,
      useNativeDriver: true
    }).start();

    hideBannerTimerRef.current = setTimeout(() => {
      Animated.timing(bannerAnim, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true
      }).start(() => {
        activeBannerRef.current = null;
        setNotification(null);
      });
    }, 2200);
  };

  useEffect(() => {
    isListeningRef.current = isListening;
    setIsMicOn(isListening);
  }, [isListening]);

  useEffect(() => {
    chatProcessingRef.current = chatProcessing;
  }, [chatProcessing]);

  useEffect(() => {
    if (!isListening) {
      if (micPulseLoopRef.current) {
        micPulseLoopRef.current.stop();
        micPulseLoopRef.current = null;
      }
      micPulseAnim.setValue(1);
      return;
    }

    micPulseLoopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(micPulseAnim, {
          toValue: 1.05,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(micPulseAnim, {
          toValue: 1.0,
          duration: 400,
          useNativeDriver: true,
        }),
      ]),
    );
    micPulseLoopRef.current.start();

    return () => {
      if (micPulseLoopRef.current) {
        micPulseLoopRef.current.stop();
        micPulseLoopRef.current = null;
      }
      micPulseAnim.setValue(1);
    };
  }, [isListening, micPulseAnim]);

  async function handleStopListening() {
    if (!isListeningRef.current) {
      return;
    }

    if (chatAutoStopTimerRef.current) {
      clearTimeout(chatAutoStopTimerRef.current);
      chatAutoStopTimerRef.current = null;
    }

    setIsListening(false);
    setChatProcessing(true);
    showNotification("Thinking...", "info");

    try {
      const audioUri = await stopRecording();
      if (!audioUri) {
        setChatProcessing(false);
        return;
      }

      const result = await sendAudioToChat(backendUrl, audioUri);
      if (!result.success) {
        const failureText =
          String(result.errorMessage || "").trim() ||
          "I had trouble understanding. Please try again.";
        extendChatPriorityWindow(400);
        setChatResponse(failureText);
        showNotification("Chat failed, please try again", "danger");
        void speak("I had trouble understanding. Please try again.", backendUrl);
        return;
      }

      const responseText = String(result.responseText || "").trim();
      if (responseText) {
        extendChatPriorityWindow(600);
        setChatResponse(responseText);
        showNotification("Clarity responded", "success");
        void speak(responseText, backendUrl);
      } else {
        const fallbackText = "I'm here with you. Could you say that again?";
        extendChatPriorityWindow(400);
        setChatResponse(fallbackText);
        showNotification("Please try again", "info");
        void speak(fallbackText, backendUrl);
      }
    } catch (error) {
      console.error("Stop listening error:", error);
    } finally {
      setChatProcessing(false);
    }
  }

  async function handleStartListening() {
    if (isListeningRef.current || chatProcessingRef.current) {
      return;
    }
    if (AppState.currentState !== "active") {
      return;
    }

    try {
      setChatResponse("");
      setIsListening(true);
      extendChatPriorityWindow(500);
      showNotification("Listening...", "info");
      await startRecording();
      if (chatAutoStopTimerRef.current) {
        clearTimeout(chatAutoStopTimerRef.current);
      }
      chatAutoStopTimerRef.current = setTimeout(() => {
        void handleStopListening();
      }, CHAT_AUTO_STOP_MS);
    } catch (error) {
      console.error("Start listening error:", error);
      setIsListening(false);
    }
  }

  function handleMicToggle() {
    if (isListeningRef.current) {
      void handleStopListening();
      return;
    }
    void handleStartListening();
  }

  function extendChatPriorityWindow(durationMs = 500) {
    const next = Date.now() + durationMs;
    chatPriorityUntilRef.current = Math.max(chatPriorityUntilRef.current, next);
  }

  function speakSystemText(text: string, options?: { force?: boolean }) {
    const cleaned = String(text || "").trim();
    if (!cleaned) {
      return;
    }
    const now = Date.now();
    const forced = Boolean(options?.force);
    if (!forced && (isListeningRef.current || chatProcessingRef.current)) {
      return;
    }
    if (!forced && now - lastSystemSpeechAtRef.current < SYSTEM_SPEECH_MIN_GAP_MS) {
      return;
    }
    lastSystemSpeechAtRef.current = now;
    void speak(cleaned, backendUrl);
  }

  useEffect(() => {
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) {
      return;
    }

    const supabase = createClient(url, anonKey);
    const channel = supabase
      .channel(`wake-word-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "events",
          filter: "type=eq.wake_word_detected",
        },
        () => {
          if (!isListeningRef.current && !chatProcessingRef.current) {
            void handleStartListening();
          }
        },
      )
      .subscribe();

    supabaseChannelRef.current = channel;

    return () => {
      if (supabaseChannelRef.current) {
        void supabase.removeChannel(supabaseChannelRef.current);
        supabaseChannelRef.current = null;
      }
    };
  }, []);

  async function pingHealth() {
    if (!backendUrl) {
      setIsConnected(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch(`${backendUrl}/health`, { signal: controller.signal });
      setIsConnected(response.ok);
    } catch {
      setIsConnected(false);
    } finally {
      clearTimeout(timeout);
    }
  }

  useEffect(() => {
    void requestCameraPermission();
  }, [requestCameraPermission]);

  useEffect(() => {
    const setupLocationPermission = async () => {
      try {
        const current = await Location.getForegroundPermissionsAsync();
        if (current.status === "granted") {
          setLocationPermissionGranted(true);
          setLocationStatus("Loc: permission granted");
          return;
        }

        const requested = await Location.requestForegroundPermissionsAsync();
        const granted = requested.status === "granted";
        setLocationPermissionGranted(granted);
        setLocationStatus(granted ? "Loc: permission granted" : "Loc: permission denied");
      } catch {
        setLocationPermissionGranted(false);
        setLocationStatus("Loc: permission error");
      }
    };
    void setupLocationPermission();
  }, []);

  useEffect(() => {
    const setupNotifications = async () => {
      try {
        const current = await Notifications.getPermissionsAsync();
        let granted = current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
        if (!granted) {
          const requested = await Notifications.requestPermissionsAsync();
          granted =
            requested.granted ||
            requested.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
        }
        setNotificationsPermissionGranted(granted);
      } catch {
        setNotificationsPermissionGranted(false);
      }
    };
    void setupNotifications();
  }, []);

  useEffect(() => {
    void pingHealth();
    const healthTimer = setInterval(() => {
      void pingHealth();
    }, 5000);
    return () => clearInterval(healthTimer);
  }, [backendUrl]);

  useEffect(() => {
    void registerDevicePushToken();
  }, [backendUrl, notificationsPermissionGranted]);

  useEffect(() => {
    if (!backendUrl) {
      return;
    }

    const pollDueMedication = async () => {
      const dueResult = await fetchDueMedication();
      if (!dueResult) {
        return;
      }
      setDueMedication(dueResult);
      if (!dueResult.due) {
        setActiveReminderText("");
        return;
      }

      const dueKey = String(dueResult.due_key || "").trim();
      if (dueKey && medicationLoggedDueKeyRef.current === dueKey) {
        setActiveReminderText("");
        return;
      }

      const medicationName = String(dueResult.medication_name || dueResult.reminder_label || "your medication");
      const reminderText = `Reminder: It's time for ${medicationName}. Please show the bottle to the camera.`;
      setActiveReminderText(reminderText);
      if (!dueKey || reminderAlertedDueKeyRef.current === dueKey) {
        return;
      }

      reminderAlertedDueKeyRef.current = dueKey;
      await scheduleLocalMedicationAlert(reminderText);
      speakSystemText(reminderText);
    };

    void pollDueMedication();
    const timer = setInterval(() => {
      void pollDueMedication();
    }, 5000);
    return () => clearInterval(timer);
  }, [backendUrl, notificationsPermissionGranted]);

  useEffect(() => {
    if (!backendUrl) {
      return;
    }

    const pollReminderEvents = async () => {
      const events = await fetchRecentEvents(20);
      if (!events || events.length === 0) {
        return;
      }

      const now = Date.now();
      const recentLoggedReminderIds = new Set(
        events
          .filter((event) => event.type === "medication_taken")
          .map((event) => String(event.payload?.reminder_id || "").trim())
          .filter(Boolean)
      );

      const reminderEvents = events
        .filter((event) => event.type === "reminder_fired")
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      for (const event of reminderEvents) {
        if (seenReminderEventIdsRef.current[event.id]) {
          continue;
        }

        const eventTimeMs = new Date(event.created_at).getTime();
        if (!Number.isFinite(eventTimeMs) || now - eventTimeMs > REMINDER_EVENT_WINDOW_MS) {
          seenReminderEventIdsRef.current[event.id] = true;
          continue;
        }

        const reminderId = String(event.payload?.reminder_id || "").trim();
        if (reminderId && recentLoggedReminderIds.has(reminderId)) {
          seenReminderEventIdsRef.current[event.id] = true;
          continue;
        }

        seenReminderEventIdsRef.current[event.id] = true;
        const medicationName = String(event.payload?.medication_name || event.payload?.label || "your medication");
        const reminderText = `Reminder: It's time for ${medicationName}. Please show the bottle to the camera.`;
        setActiveReminderText(reminderText);
        await scheduleLocalMedicationAlert(reminderText);
        speakSystemText(reminderText);
      }
    };

    void pollReminderEvents();
    const timer = setInterval(() => {
      void pollReminderEvents();
    }, 8000);
    return () => clearInterval(timer);
  }, [backendUrl, notificationsPermissionGranted]);

  async function pushPatientLocation(position?: Location.LocationObject) {
    if (!backendUrl || locationPermissionGranted !== true || locationInFlightRef.current) {
      return;
    }

    locationInFlightRef.current = true;
    try {
      const sourcePosition =
        position ||
        (await Location.getLastKnownPositionAsync()) ||
        (await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced
        }));

      if (!sourcePosition) {
        setLocationStatus("Loc: waiting for GPS");
        return;
      }

      const response = await fetch(`${backendUrl}/geofence/location`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: sourcePosition.coords.latitude,
          longitude: sourcePosition.coords.longitude,
          accuracy_meters:
            typeof sourcePosition.coords.accuracy === "number" ? sourcePosition.coords.accuracy : null,
          timestamp: new Date().toISOString()
        })
      });
      if (!response.ok) {
        setLocationStatus(`Loc: upload failed (${response.status})`);
        return;
      }
      setLocationStatus("Loc: live");
    } catch {
      setLocationStatus("Loc: upload error");
    } finally {
      locationInFlightRef.current = false;
    }
  }

  async function registerDevicePushToken() {
    if (!backendUrl || notificationsPermissionGranted !== true || pushTokenRegisteredRef.current) {
      return;
    }
    try {
      const configuredProjectId = String(
        Constants.expoConfig?.extra?.easProjectId || Constants.easConfig?.projectId || ""
      ).trim();

      const tokenResult = configuredProjectId
        ? await Notifications.getExpoPushTokenAsync({ projectId: configuredProjectId })
        : await Notifications.getExpoPushTokenAsync();
      const token = String(tokenResult.data || "").trim();
      if (!token) {
        return;
      }

      const response = await fetch(`${backendUrl}/device-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      if (response.ok) {
        pushTokenRegisteredRef.current = true;
      }
    } catch {
      // Best-effort token registration for reminder push notifications.
    }
  }

  async function scheduleLocalMedicationAlert(text: string) {
    if (notificationsPermissionGranted !== true) {
      return;
    }
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Medication Reminder",
          body: text,
          sound: "default"
        },
        trigger: null
      });
    } catch {
      // Local alerts are best effort; foreground banner + speech still runs.
    }
  }

  async function fetchDueMedication(): Promise<MedicationDueResponse | null> {
    if (!backendUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`${backendUrl}/medication/due`, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as MedicationDueResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchRecentEvents(limit = 20): Promise<EventRecord[] | null> {
    if (!backendUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`${backendUrl}/events?limit=${limit}`, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as EventRecord[];
      return Array.isArray(payload) ? payload : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function postMedicationVerify(imageUri: string): Promise<MedicationVerifyResponse | null> {
    if (!backendUrl) {
      return null;
    }

    const form = new FormData();
    form.append("image", {
      uri: imageUri,
      name: "capture.jpg",
      type: "image/jpeg"
    } as never);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${backendUrl}/medication/verify`, {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as MedicationVerifyResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function maybeVerifyMedicationFromFrame(imageUri: string, options?: { force?: boolean }) {
    if ((!dueMedication?.due && !activeReminderText) || medicationVerifyInFlightRef.current) {
      return;
    }
    const forced = Boolean(options?.force);
    const now = Date.now();
    if (!forced && now - lastMedicationVerifyAtRef.current < MEDICATION_VERIFY_INTERVAL_MS) {
      return;
    }
    lastMedicationVerifyAtRef.current = now;
    medicationVerifyInFlightRef.current = true;
    try {
      const verifyResult = await postMedicationVerify(imageUri);
      if (!verifyResult || !verifyResult.correct_medication_visible) {
        return;
      }

      if (verifyResult.logged_intake && verifyResult.due_key) {
        const dueKey = String(verifyResult.due_key);
        if (medicationLoggedDueKeyRef.current === dueKey) {
          return;
        }
        medicationLoggedDueKeyRef.current = dueKey;
        const medicationName = String(verifyResult.medication_name || dueMedication?.medication_name || "medication");
        const successText = `${medicationName} confirmed and logged for your caregiver.`;
        setActiveReminderText("");
        setDueMedication((current) => (current ? { ...current, due: false, intake_logged: true } : current));
        await scheduleLocalMedicationAlert(successText);
        speakSystemText(successText, { force: true });
      }
    } finally {
      medicationVerifyInFlightRef.current = false;
    }
  }

  async function captureFrameUri(): Promise<string | null> {
    if (!cameraRef.current || !isCameraReady || captureLockRef.current) {
      return null;
    }

    captureLockRef.current = true;
    try {
      const capture = await cameraRef.current.takePictureAsync({
        quality: 0.65,
        base64: false,
        skipProcessing: true
      });
      return capture?.uri ?? null;
    } catch {
      return null;
    } finally {
      captureLockRef.current = false;
    }
  }

  async function postImage(
    endpoint: "/detect-live",
    imageUri: string
  ): Promise<DetectLiveResponse | null> {
    if (!backendUrl) {
      return null;
    }

    const form = new FormData();
    form.append("image", {
      uri: imageUri,
      name: "capture.jpg",
      type: "image/jpeg"
    } as never);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(`${backendUrl}${endpoint}`, {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      return response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function analyzeTick() {
    if (!cameraPermission?.granted || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    try {
      const imageUri = await captureFrameUri();
      if (!imageUri) {
        return;
      }

      const payload = await postImage("/detect-live", imageUri);
      if (!payload) {
        return;
      }

      setDetections(Array.isArray(payload.detections) ? payload.detections : []);
      setFrameSize({
        width: Number(payload.image_size?.width || 0),
        height: Number(payload.image_size?.height || 0)
      });

      const alert = payload.primary_alert;
      if (!alert || alert.type === "none") {
        lastAlertSignatureRef.current = "none";
        return;
      }

      const alertText = String(alert.text || "").trim();
      const speakTextValue = String(alert.speak_text || "").trim();
      if (alertText && !activeReminderText) {
        setLastDetectionText(alertText);
        showNotification(alertText, alert.severity || "info");
      }
      if (!speakTextValue) {
        return;
      }

      const key = String(alert.cooldown_key || alert.type || "general");
      const signature = `${alert.type}|${key}|${speakTextValue}`;
      const hasChanged = signature !== lastAlertSignatureRef.current;
      lastAlertSignatureRef.current = signature;

      const now = Date.now();
      const lastSpokenAt = lastSpokenAtRef.current[key] || 0;
      const dueMedicationActive = Boolean(dueMedication?.due) || Boolean(activeReminderText);
      const suppressPillOkSpeech = alert.type === "pill_ok" && dueMedicationActive;
      const alertCooldownMs =
        alert.type === "face"
          ? FACE_SPEECH_COOLDOWN_MS
          : alert.type === "pill_ok" || alert.type === "pill_wrong"
            ? PILL_SPEECH_COOLDOWN_MS
            : 0;
      if (
        hasChanged &&
        now - lastSpokenAt >= alertCooldownMs &&
        !suppressPillOkSpeech &&
        (alert.type === "face" || (!isListeningRef.current && !chatProcessingRef.current))
      ) {
        const spokenMessage =
          alert.type === "face" ? "That's RJ, your brother." : speakTextValue;
        speakSystemText(spokenMessage, alert.type === "face" ? { force: true } : undefined);
        lastSpokenAtRef.current[key] = now;
      }

      if (alert.type === "pill_ok" && (dueMedication?.due || Boolean(activeReminderText))) {
        await maybeVerifyMedicationFromFrame(imageUri, { force: true });
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!cameraPermission?.granted || !isCameraReady) {
      return;
    }

    void analyzeTick();
    tickIntervalRef.current = setInterval(() => {
      void analyzeTick();
    }, ANALYZE_TICK_INTERVAL_MS);

    return () => {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
    };
  }, [cameraPermission?.granted, backendUrl, isCameraReady, dueMedication?.due, dueMedication?.due_key, activeReminderText]);

  useEffect(() => {
    return () => {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      if (hideBannerTimerRef.current) {
        clearTimeout(hideBannerTimerRef.current);
        hideBannerTimerRef.current = null;
      }
      if (locationWatchRef.current) {
        locationWatchRef.current.remove();
        locationWatchRef.current = null;
      }
      if (chatAutoStopTimerRef.current) {
        clearTimeout(chatAutoStopTimerRef.current);
        chatAutoStopTimerRef.current = null;
      }
      if (supabaseChannelRef.current) {
        supabaseChannelRef.current = null;
      }
      void stopRecording();
    };
  }, []);

  useEffect(() => {
    if (!backendUrl || locationPermissionGranted !== true) {
      return;
    }

    let cancelled = false;
    const startLocationWatch = async () => {
      try {
        const servicesEnabled = await Location.hasServicesEnabledAsync();
        if (!servicesEnabled) {
          setLocationStatus("Loc: services disabled");
          return;
        }

        const initial = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced
        });
        if (!cancelled) {
          void pushPatientLocation(initial);
        }

        const watch = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: LOCATION_WATCH_TIME_INTERVAL_MS,
            distanceInterval: LOCATION_WATCH_DISTANCE_METERS
          },
          (update) => {
            void pushPatientLocation(update);
          }
        );

        if (cancelled) {
          watch.remove();
          return;
        }
        locationWatchRef.current = watch;
      } catch {
        setLocationStatus("Loc: watch error");
      }
    };

    void startLocationWatch();
    const fallbackTimer = setInterval(() => {
      void pushPatientLocation();
    }, LOCATION_FALLBACK_PUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(fallbackTimer);
      if (locationWatchRef.current) {
        locationWatchRef.current.remove();
        locationWatchRef.current = null;
      }
    };
  }, [backendUrl, locationPermissionGranted]);

  return (
    <View style={styles.container}>
      <View
        style={styles.cameraRegion}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewportSize({ width, height });
        }}
      >
        <CameraView
          ref={cameraRef}
          facing="back"
          onCameraReady={() => {
            setIsCameraReady(true);
          }}
          style={styles.camera}
        />

        <View pointerEvents="none" style={styles.overlayLayer}>
          {renderedBoxes.map((box) => (
            <View
              key={box.key}
              style={[
                styles.box,
                {
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  borderColor: box.color
                }
              ]}
            >
              <View style={[styles.boxLabelWrap, { borderColor: box.color }]}>
                <Text style={[styles.boxLabel, { color: box.color }]} numberOfLines={1}>
                  {box.label}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {notification ? (
          <Animated.View
            style={[
              styles.notificationWrap,
              { top: notificationTopInset },
              {
                opacity: bannerAnim,
                transform: [
                  {
                    translateY: bannerAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-24, 0]
                    })
                  }
                ]
              }
            ]}
          >
            <View
              style={[
                styles.notificationBanner,
                notification.severity === "success"
                  ? styles.notificationSuccess
                  : notification.severity === "danger"
                    ? styles.notificationDanger
                    : styles.notificationInfo
              ]}
            >
              <Text style={styles.notificationText}>{notification.text}</Text>
            </View>
          </Animated.View>
        ) : null}

        {activeReminderText ? (
          <View pointerEvents="none" style={[styles.reminderPersistentWrap, { top: notificationTopInset + 64 }]}>
            <View style={styles.reminderPersistentBanner}>
              <Text style={styles.reminderPersistentTitle}>Medication Due</Text>
              <Text style={styles.reminderPersistentText}>{activeReminderText}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.chatOverlay}>
          <View style={styles.chatResponseWrap}>
            <Text style={styles.chatResponseText} numberOfLines={3}>
              {chatResponse || activeReminderText || lastDetectionText}
            </Text>
          </View>
          <View style={styles.chatMicWrap}>
            <Animated.View style={[styles.micButtonAnimatedWrap, { transform: [{ scale: micPulseAnim }] }]}>
              <Pressable
                disabled={chatProcessing}
                onPress={handleMicToggle}
                style={[
                  styles.micButton,
                  isMicOn
                    ? styles.micButtonListening
                    : chatProcessing
                      ? styles.micButtonProcessing
                      : styles.micButtonIdle,
                ]}
              >
                {chatProcessing ? (
                  <ActivityIndicator color="#444444" size="small" />
                ) : (
                  <MaterialIcons
                    name="mic"
                    size={30}
                    style={[styles.micIcon, isMicOn ? styles.micIconListening : styles.micIconIdle]}
                  />
                )}
              </Pressable>
            </Animated.View>
            <Text
              style={[
                styles.chatMicLabel,
                isMicOn
                  ? styles.chatMicLabelListening
                  : chatProcessing
                    ? styles.chatMicLabelProcessing
                    : styles.chatMicLabelIdle,
              ]}
            >
              {isMicOn ? "Listening..." : chatProcessing ? "Thinking..." : "Say 'Hey Clarity' or tap mic"}
            </Text>
          </View>
        </View>

        <View style={styles.connectionIndicator}>
          <View style={[styles.connectionDot, { backgroundColor: isConnected ? "#22C55E" : "#EF4444" }]} />
          <Text style={styles.connectionText}>{isConnected ? "Connected" : "Offline"}</Text>
        </View>
        {!cameraPermission?.granted ? (
          <View style={styles.permissionOverlay}>
            <Text style={styles.permissionText}>Please allow camera access.</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0A0A"
  },
  cameraRegion: {
    flex: 1,
    width: "100%",
    position: "relative"
  },
  camera: {
    ...StyleSheet.absoluteFillObject
  },
  overlayLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
    elevation: 5
  },
  box: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 8,
    overflow: "visible",
    zIndex: 6
  },
  boxLabelWrap: {
    position: "absolute",
    left: -2,
    top: -32,
    maxWidth: 280,
    backgroundColor: "rgba(10,10,10,0.88)",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  boxLabel: {
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 0.2
  },
  notificationWrap: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 12,
    elevation: 12
  },
  notificationBanner: {
    width: "100%",
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: "center"
  },
  notificationInfo: {
    backgroundColor: "rgba(17,17,17,0.94)",
    borderColor: "#3B82F6"
  },
  notificationSuccess: {
    backgroundColor: "rgba(17,17,17,0.94)",
    borderColor: "#22C55E"
  },
  notificationDanger: {
    backgroundColor: "rgba(17,17,17,0.94)",
    borderColor: "#EF4444"
  },
  notificationText: {
    color: "#F5F5F5",
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
    letterSpacing: 0.2
  },
  reminderPersistentWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 11,
    elevation: 11
  },
  reminderPersistentBanner: {
    width: "100%",
    borderWidth: 1,
    borderColor: "#EAB308",
    borderRadius: 10,
    backgroundColor: "rgba(17,17,17,0.94)",
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  reminderPersistentTitle: {
    color: "#EAB308",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase"
  },
  reminderPersistentText: {
    marginTop: 4,
    color: "#F5F5F5",
    fontSize: 13,
    fontWeight: "400"
  },
  chatOverlay: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 16,
    zIndex: 12,
    elevation: 12,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  chatResponseWrap: {
    minHeight: 40,
    marginBottom: 10,
    justifyContent: "center"
  },
  chatResponseText: {
    fontSize: 16,
    lineHeight: 22,
    color: "#F5F5F5",
    fontWeight: "400",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3
  },
  chatMicWrap: {
    alignItems: "center",
    justifyContent: "center"
  },
  micButtonAnimatedWrap: {
    alignItems: "center",
    justifyContent: "center"
  },
  micButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center"
  },
  micButtonIdle: {
    backgroundColor: "#1A1A1A",
    borderWidth: 1,
    borderColor: "#333333"
  },
  micButtonListening: {
    backgroundColor: "#1A1A1A",
    borderWidth: 2,
    borderColor: "#EF4444"
  },
  micButtonProcessing: {
    backgroundColor: "#111111",
    borderWidth: 1,
    borderColor: "#2A2A2A"
  },
  micIcon: {
    fontSize: 30
  },
  micIconIdle: {
    color: "#666666"
  },
  micIconListening: {
    color: "#EF4444"
  },
  chatMicLabel: {
    marginTop: 6,
    fontSize: 11
  },
  chatMicLabelIdle: {
    color: "#333333"
  },
  chatMicLabelListening: {
    color: "#EF4444"
  },
  chatMicLabelProcessing: {
    color: "#444444"
  },
  connectionIndicator: {
    position: "absolute",
    top: 76,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
    zIndex: 12,
    elevation: 12
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  connectionText: {
    color: "#F5F5F5",
    fontSize: 12,
    fontWeight: "400"
  },
  permissionOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.62)"
  },
  permissionText: {
    color: "#F5F5F5",
    fontSize: 16,
    fontWeight: "400",
    textAlign: "center"
  }
});
