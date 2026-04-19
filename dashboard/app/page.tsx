"use client";

import dynamic from "next/dynamic";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import RoomViewer from "@/components/RoomViewer";

type Tab = "family" | "zone" | "reminders" | "room" | "log" | "conversation";

type FamilyReference = {
  id: string;
  name: string;
  relationship: string;
  photo_path: string;
  photo_url: string | null;
  created_at: string;
};

type GeofenceConfig = {
  latitude: number;
  longitude: number;
  radius_meters: number;
};

type PatientLocation = {
  available: boolean;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  timestamp: string | null;
};

type Reminder = {
  id: string;
  label: string;
  time: string;
  days: string[];
  active: boolean;
  dosage?: string;
};

type MedicationDueStatus = {
  due: boolean;
  intake_logged?: boolean;
  reminder_id?: string | null;
  reminder_label?: string | null;
  medication_name?: string | null;
  reminder_time?: string | null;
  due_key?: string | null;
  guidance?: string;
};

type EventRecord = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type ConversationTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type AlertPopup = {
  kind: "reminder" | "success";
  title: string;
  body: string;
};

type NominatimResult = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
};

type ZoneDraftSnapshot = {
  center: { latitude: number; longitude: number };
  radius_meters: number;
};

const SafeZoneMap = dynamic(
  () =>
    import("@/components/SafeZoneMap").catch((error) => {
      if (typeof window !== "undefined") {
        const chunkLoadFailed =
          error instanceof Error &&
          /(ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module)/i.test(error.message);
        if (chunkLoadFailed && !window.sessionStorage.getItem("safeZoneMapChunkRetry")) {
          window.sessionStorage.setItem("safeZoneMapChunkRetry", "1");
          window.location.reload();
        }
      }
      throw error;
    }),
  {
    ssr: false,
    loading: () => <div className="map-shell">Loading map…</div>
  }
);

const DAY_OPTIONS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND = ["sat", "sun"];
const EVERY_DAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PATIENT_LOCATION_POLL_INTERVAL_MS = 2500;

function formatReminderDays(days: string[]): string {
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  return order.filter((day) => days.includes(day)).map((day) => day.slice(0, 1).toUpperCase() + day.slice(1)).join(", ");
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "Unknown time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const prefix = isToday ? "Today" : date.toLocaleDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${prefix} at ${time}`;
}

function displayTimestamp(value: unknown, hydrated: boolean): string {
  if (!hydrated) {
    if (typeof value === "string" && value) {
      return value;
    }
    return "Unknown time";
  }
  return formatTimestamp(value);
}

function isRecentTimestamp(value: string, windowMs: number): boolean {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return Date.now() - parsed <= windowMs;
}

function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const deltaLatitude = toRadians(latitudeB - latitudeA);
  const deltaLongitude = toRadians(longitudeB - longitudeA);

  const latitudeARadians = toRadians(latitudeA);
  const latitudeBRadians = toRadians(latitudeB);

  const halfLatitudeSine = Math.sin(deltaLatitude / 2);
  const halfLongitudeSine = Math.sin(deltaLongitude / 2);

  const a =
    halfLatitudeSine * halfLatitudeSine +
    Math.cos(latitudeARadians) *
      Math.cos(latitudeBRadians) *
      halfLongitudeSine *
      halfLongitudeSine;

  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function eventBadge(event: EventRecord): { className: string; label: string } {
  const payload = event.payload || {};
  if (event.type === "face_identified") {
    return { className: "badge-face", label: "FACE" };
  }
  if (event.type === "pill_bottle_check") {
    const correctMedication =
      payload.correct_medication === true || String(payload.result || "").toLowerCase() === "correct";
    return correctMedication
      ? { className: "badge-pill-ok", label: "PILL OK" }
      : { className: "badge-pill-wrong", label: "WRONG PILL" };
  }
  if (event.type === "geofence_breach") {
    return { className: "badge-alert", label: "ALERT" };
  }
  if (event.type === "reminder_fired") {
    return { className: "badge-reminder", label: "REMINDER" };
  }
  if (event.type === "wake_word_detected") {
    return { className: "badge-object", label: "WAKE" };
  }
  if (event.type === "medication_taken") {
    return { className: "badge-pill-ok", label: "MED TAKEN" };
  }
  if (event.type === "object_identified") {
    return { className: "badge-object", label: "OBJECT" };
  }
  return { className: "badge-default", label: "EVENT" };
}

function eventText(event: EventRecord): string {
  const payload = event.payload || {};
  if (event.type === "face_identified") {
    return `${String(payload.name || "Unknown")} (${String(payload.relationship || "family")}) identified.`;
  }
  if (event.type === "pill_bottle_check") {
    if (typeof payload.description === "string" && payload.description.trim()) {
      return payload.description.trim();
    }
    const correctMedication =
      payload.correct_medication === true || String(payload.result || "").toLowerCase() === "correct";
    return correctMedication ? "Correct medication confirmed." : "Incorrect medication detected.";
  }
  if (event.type === "geofence_breach") {
    return "Patient left the safe zone.";
  }
  if (event.type === "reminder_fired") {
    return `Reminder fired: ${String(payload.medication_name || payload.label || "Medication")}.`;
  }
  if (event.type === "wake_word_detected") {
    return "Wake phrase detected on assistant microphone.";
  }
  if (event.type === "medication_taken") {
    return `Medication logged: ${String(payload.medication_name || payload.label || "Medication")}.`;
  }
  if (event.type === "object_identified") {
    return String(payload.description || "Object identified.");
  }
  return "Event recorded.";
}

export default function DashboardPage() {
  const backendUrl = useMemo(
    () => (process.env.NEXT_PUBLIC_BACKEND_URL || "").trim().replace(/\/+$/, ""),
    []
  );

  const [activeTab, setActiveTab] = useState<Tab>("family");
  const [status, setStatus] = useState("Loading...");
  const [isHydrated, setIsHydrated] = useState(false);

  const [family, setFamily] = useState<FamilyReference[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [medicationDueStatus, setMedicationDueStatus] = useState<MedicationDueStatus | null>(null);
  const [flytoPill, setFlytoPill] = useState(false);
  const [pillDetected, setPillDetected] = useState(false);
  const [freshEventIds, setFreshEventIds] = useState<string[]>([]);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [wakeWordListening, setWakeWordListening] = useState(false);

  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  const [isUploadingFamily, setIsUploadingFamily] = useState(false);
  const [isDeletingFamilyId, setIsDeletingFamilyId] = useState<string | null>(null);

  const [center, setCenter] = useState({ latitude: 30.2672, longitude: -97.7431 });
  const [radiusMeters, setRadiusMeters] = useState(200);
  const [zoneUndoSnapshot, setZoneUndoSnapshot] = useState<ZoneDraftSnapshot | null>(null);
  const [zonePopToken, setZonePopToken] = useState(0);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<NominatimResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isGeocodingAddress, setIsGeocodingAddress] = useState(false);
  const [mapFlyTo, setMapFlyTo] = useState<{ lat: number; lng: number } | null>(null);
  const addressDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressWrapperRef = useRef<HTMLDivElement | null>(null);
  const [configuredZone, setConfiguredZone] = useState<GeofenceConfig | null>(null);
  const [patientLocation, setPatientLocation] = useState<PatientLocation | null>(null);
  const [isSavingZone, setIsSavingZone] = useState(false);
  const [showZoneBreachPopup, setShowZoneBreachPopup] = useState(false);
  const wasOutsideSafeZoneRef = useRef(false);
  const [isSendingBreachAlert, setIsSendingBreachAlert] = useState(false);
  const [alertPopup, setAlertPopup] = useState<AlertPopup | null>(null);
  const seenDashboardEventIdsRef = useRef<Record<string, true>>({});
  const seededDashboardEventIdsRef = useRef(false);
  const flytoPillResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pillDetectedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [reminderLabel, setReminderLabel] = useState("");
  const [reminderDosage, setReminderDosage] = useState("");
  const [reminderTimes, setReminderTimes] = useState<string[]>(["09:00"]);
  const [reminderDays, setReminderDays] = useState<string[]>([...WEEKDAYS]);
  const [todayKey, setTodayKey] = useState<(typeof DAY_OPTIONS)[number]>("mon");
  const [isCreatingReminder, setIsCreatingReminder] = useState(false);
  const [isDeletingReminderId, setIsDeletingReminderId] = useState<string | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const wakeWordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const distanceFromSafeZoneMeters = useMemo(() => {
    if (
      !configuredZone ||
      !patientLocation ||
      patientLocation.latitude == null ||
      patientLocation.longitude == null
    ) {
      return null;
    }

    return haversineDistanceMeters(
      configuredZone.latitude,
      configuredZone.longitude,
      Number(patientLocation.latitude),
      Number(patientLocation.longitude)
    );
  }, [configuredZone, patientLocation]);

  const outsideSafeZone = useMemo(() => {
    if (!configuredZone || distanceFromSafeZoneMeters == null) {
      return false;
    }
    return distanceFromSafeZoneMeters > configuredZone.radius_meters;
  }, [configuredZone, distanceFromSafeZoneMeters]);

  const latestMedicationTakenEvent = useMemo(() => {
    return events.find((event) => event.type === "medication_taken") ?? null;
  }, [events]);

  const calendarByDay = useMemo(() => {
    return DAY_OPTIONS.map((day) => ({
      day,
      reminders: reminders
        .filter((r) => r.days.includes(day))
        .sort((a, b) => a.time.localeCompare(b.time))
    }));
  }, [reminders]);

  const todaysReminders = useMemo(
    () => reminders.filter((r) => r.days.includes(todayKey)).sort((a, b) => a.time.localeCompare(b.time)),
    [reminders, todayKey]
  );

  function markEventAsFresh(eventId: string) {
    setFreshEventIds((current) => (current.includes(eventId) ? current : [eventId, ...current]));
    setTimeout(() => {
      setFreshEventIds((current) => current.filter((id) => id !== eventId));
    }, 30);
  }

  function handleIncomingEventAlert(event: EventRecord) {
    if (seenDashboardEventIdsRef.current[event.id]) {
      return;
    }
    seenDashboardEventIdsRef.current[event.id] = true;

    if (!isRecentTimestamp(event.created_at, 3 * 60 * 1000)) {
      return;
    }

    if (event.type === "pill_bottle_check") {
      const correctMedication =
        event.payload?.correct_medication === true ||
        String(event.payload?.result || "").toLowerCase() === "correct";
      if (correctMedication) {
        setPillDetected(true);
        setFlytoPill(true);
        if (flytoPillResetTimerRef.current) {
          clearTimeout(flytoPillResetTimerRef.current);
        }
        flytoPillResetTimerRef.current = setTimeout(() => {
          setFlytoPill(false);
        }, 300);
        if (pillDetectedResetTimerRef.current) {
          clearTimeout(pillDetectedResetTimerRef.current);
        }
        pillDetectedResetTimerRef.current = setTimeout(() => {
          setPillDetected(false);
        }, 30000);
      }
    }

    if (event.type === "wake_word_detected") {
      setWakeWordListening(true);
      if (wakeWordTimerRef.current) {
        clearTimeout(wakeWordTimerRef.current);
      }
      wakeWordTimerRef.current = setTimeout(() => {
        setWakeWordListening(false);
      }, 10_000);
      return;
    }

    if (event.type === "reminder_fired") {
      const medication = String(event.payload?.medication_name || event.payload?.label || "Medication");
      setAlertPopup({
        kind: "reminder",
        title: "Medication Reminder",
        body: `It's time for ${medication}. Please verify the bottle on the phone camera.`
      });
      setStatus(`Reminder fired: ${medication}.`);
      return;
    }

    if (event.type === "medication_taken") {
      const medication = String(event.payload?.medication_name || event.payload?.label || "Medication");
      setAlertPopup({
        kind: "success",
        title: "Medication Logged",
        body: `${medication} was verified on the phone and logged for caregiver review.`
      });
      setStatus(`Medication logged: ${medication}.`);
    }
  }

  async function loadFamily() {
    const response = await fetch("/api/family", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Family fetch failed");
    }
    const payload = (await response.json()) as FamilyReference[];
    setFamily(payload);
  }

  async function loadEvents() {
    try {
      const response = await fetch("/api/events?limit=100", { cache: "no-store" });
      if (!response.ok) {
        setStatus("Live log temporarily unavailable.");
        return;
      }
      const payload = (await response.json()) as EventRecord[];
      const nextEvents = payload.slice(0, 100);
      setEvents(nextEvents);

      if (!seededDashboardEventIdsRef.current) {
        for (const event of nextEvents) {
          seenDashboardEventIdsRef.current[event.id] = true;
        }
        seededDashboardEventIdsRef.current = true;
        return;
      }

      const ordered = [...nextEvents].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      for (const event of ordered) {
        handleIncomingEventAlert(event);
      }
    } catch {
      setStatus("Live log temporarily unavailable.");
    }
  }

  async function loadConversations() {
    const response = await fetch("/api/conversations?limit=300", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Conversations fetch failed");
    }
    const payload = (await response.json()) as ConversationTurn[];
    const normalized = (Array.isArray(payload) ? payload : []).map((turn) => ({
      id: String(turn.id),
      role: (String(turn.role).toLowerCase() === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: String(turn.content || ""),
      created_at: String(turn.created_at || ""),
    }));
    setConversationTurns(normalized);
  }

  async function loadGeofence() {
    if (!backendUrl) {
      return;
    }
    const response = await fetch(`${backendUrl}/geofence`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Geofence fetch failed");
    }
    const payload = (await response.json()) as GeofenceConfig | { configured: false };
    if ("configured" in payload && payload.configured === false) {
      setConfiguredZone(null);
      return;
    }
    const zone = payload as GeofenceConfig;
    setConfiguredZone(zone);
    setCenter({ latitude: zone.latitude, longitude: zone.longitude });
    setRadiusMeters(zone.radius_meters);
    setZoneUndoSnapshot(null);
  }

  async function loadReminders() {
    const response = await fetch("/api/reminders", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Reminders fetch failed");
    }
    const payload = (await response.json()) as Reminder[];
    setReminders(payload);
  }

  async function loadMedicationDueStatus() {
    if (!backendUrl) {
      return;
    }
    try {
      const response = await fetch(`${backendUrl}/medication/due`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Medication due fetch failed");
      }
      const payload = (await response.json()) as MedicationDueStatus;
      setMedicationDueStatus(payload);
    } catch {
      // Keep previous value on transient errors.
    }
  }

  async function loadPatientLocation() {
    if (!backendUrl) {
      return;
    }
    try {
      const response = await fetch(`${backendUrl}/geofence/location`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Patient location fetch failed");
      }

      const payload = (await response.json()) as PatientLocation;
      if (!payload.available) {
        setPatientLocation(null);
        return;
      }

      if (payload.latitude == null || payload.longitude == null) {
        setPatientLocation(null);
        return;
      }

      setPatientLocation({
        available: true,
        latitude: Number(payload.latitude),
        longitude: Number(payload.longitude),
        accuracy_meters:
          payload.accuracy_meters == null ? null : Number(payload.accuracy_meters),
        timestamp: payload.timestamp ? String(payload.timestamp) : null
      });
    } catch {
      // keep last known location to avoid jitter on transient network failures
    }
  }

  async function refreshAll() {
    try {
      await Promise.all([
        loadFamily(),
        loadEvents(),
        loadConversations(),
        loadGeofence(),
        loadReminders(),
        loadPatientLocation(),
        loadMedicationDueStatus()
      ]);
      setStatus("Synced");
    } catch {
      setStatus("Some data failed to load. Check backend and environment variables.");
    }
  }

  useEffect(() => {
    setIsHydrated(true);
    setTodayKey((["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[new Date().getDay()]);
  }, []);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    void loadEvents();
    const timer = setInterval(() => {
      void loadEvents();
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!backendUrl) {
      return;
    }
    void loadMedicationDueStatus();
    const timer = setInterval(() => {
      void loadMedicationDueStatus();
    }, 7000);
    return () => clearInterval(timer);
  }, [backendUrl]);

  useEffect(() => {
    if (!backendUrl) {
      return;
    }
    void loadPatientLocation();
    const timer = setInterval(() => {
      void loadPatientLocation();
    }, PATIENT_LOCATION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [backendUrl]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (addressWrapperRef.current && !addressWrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!outsideSafeZone) {
      wasOutsideSafeZoneRef.current = false;
      setShowZoneBreachPopup(false);
      return;
    }

    if (!wasOutsideSafeZoneRef.current) {
      wasOutsideSafeZoneRef.current = true;
      setShowZoneBreachPopup(true);
      if (
        backendUrl &&
        patientLocation &&
        patientLocation.latitude != null &&
        patientLocation.longitude != null
      ) {
        const sendAlert = async () => {
          setIsSendingBreachAlert(true);
          try {
            await fetch(`${backendUrl}/geofence/breach`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                latitude: Number(patientLocation.latitude),
                longitude: Number(patientLocation.longitude),
                timestamp: new Date().toISOString()
              })
            });
            setStatus("Alert sent: patient is outside the safe zone.");
          } catch {
            setStatus("Warning: patient outside safe zone. Alert send failed.");
          } finally {
            setIsSendingBreachAlert(false);
          }
        };
        void sendAlert();
      } else {
        setStatus("Warning: patient is outside the safe zone.");
      }
    }
  }, [outsideSafeZone, backendUrl, patientLocation]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      setIsRealtimeConnected(false);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`events-live-${Date.now()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, (payload) => {
        const incoming = payload.new as EventRecord;
        setEvents((current) => [incoming, ...current].slice(0, 100));
        markEventAsFresh(incoming.id);
        handleIncomingEventAlert(incoming);
      })
      .subscribe((statusValue) => {
        setIsRealtimeConnected(statusValue === "SUBSCRIBED");
      });

    return () => {
      setIsRealtimeConnected(false);
      void supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`conversations-live-${Date.now()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversations" }, (payload) => {
        const incoming = payload.new as ConversationTurn;
        const normalized = {
          id: String(incoming.id),
          role: (String(incoming.role).toLowerCase() === "assistant" ? "assistant" : "user") as "user" | "assistant",
          content: String(incoming.content || ""),
          created_at: String(incoming.created_at || ""),
        };
        setConversationTurns((current) => {
          if (current.some((turn) => turn.id === normalized.id)) {
            return current;
          }
          return [...current, normalized];
        });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!conversationScrollRef.current) {
      return;
    }
    conversationScrollRef.current.scrollTop = conversationScrollRef.current.scrollHeight;
  }, [conversationTurns]);

  useEffect(() => {
    return () => {
      if (flytoPillResetTimerRef.current) {
        clearTimeout(flytoPillResetTimerRef.current);
      }
      if (pillDetectedResetTimerRef.current) {
        clearTimeout(pillDetectedResetTimerRef.current);
      }
      if (wakeWordTimerRef.current) {
        clearTimeout(wakeWordTimerRef.current);
      }
    };
  }, []);

  async function onUploadFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !relationship.trim() || !photo) {
      setStatus("Name, relationship, and photo are required.");
      return;
    }

    setIsUploadingFamily(true);
    try {
      const formData = new FormData();
      formData.append("name", name.trim());
      formData.append("relationship", relationship.trim());
      formData.append("photo", photo);

      const response = await fetch("/api/family/upload", {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        throw new Error("Upload failed");
      }

      await loadFamily();
      setName("");
      setRelationship("");
      setPhoto(null);
      setStatus("Family reference added.");
    } catch {
      setStatus("Could not upload family reference.");
    } finally {
      setIsUploadingFamily(false);
    }
  }

  async function onDeleteFamily(member: FamilyReference) {
    setIsDeletingFamilyId(member.id);
    try {
      const supabase = getSupabaseBrowserClient();

      const removePhoto = await supabase.storage.from("face-references").remove([member.photo_path]);
      if (removePhoto.error) {
        throw new Error(removePhoto.error.message);
      }

      const removeRecord = await supabase.from("face_references").delete().eq("id", member.id);
      if (removeRecord.error) {
        throw new Error(removeRecord.error.message);
      }

      if (backendUrl) {
        await fetch(`${backendUrl}/sync-faces`, { method: "POST" }).catch(() => undefined);
      }

      setFamily((current) => current.filter((entry) => entry.id !== member.id));
      setStatus("Family member removed.");
    } catch {
      setStatus("Delete failed. Check Supabase permissions.");
    } finally {
      setIsDeletingFamilyId(null);
    }
  }

  function onAddressInput(value: string) {
    setAddressQuery(value);
    if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current);
    if (!value.trim()) {
      setAddressSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    addressDebounceRef.current = setTimeout(() => {
      setIsGeocodingAddress(true);
      fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(value.trim())}`)
        .then((r) => r.json())
        .then((data: NominatimResult[]) => {
          setAddressSuggestions(data);
          setShowSuggestions(true);
        })
        .catch(() => setAddressSuggestions([]))
        .finally(() => setIsGeocodingAddress(false));
    }, 350);
  }

  function onSelectSuggestion(result: NominatimResult) {
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);
    setZoneUndoSnapshot({
      center: { ...center },
      radius_meters: radiusMeters,
    });
    setCenter({ latitude: lat, longitude: lng });
    setMapFlyTo({ lat, lng });
    setZonePopToken((current) => current + 1);
    setAddressQuery(result.display_name);
    setShowSuggestions(false);
    setAddressSuggestions([]);
  }

  function onAddressFormSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (addressSuggestions.length > 0) {
      onSelectSuggestion(addressSuggestions[0]);
    }
  }

  async function onSaveSafeZone() {
    if (!backendUrl) {
      setStatus("NEXT_PUBLIC_BACKEND_URL is missing.");
      return;
    }

    setIsSavingZone(true);
    try {
      const response = await fetch(`${backendUrl}/geofence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: center.latitude,
          longitude: center.longitude,
          radius_meters: radiusMeters
        })
      });
      if (!response.ok) {
        throw new Error("Save failed");
      }
      const payload = (await response.json()) as GeofenceConfig;
      setConfiguredZone(payload);
      setZoneUndoSnapshot(null);
      setStatus("Safe zone saved.");
    } catch {
      setStatus("Could not save safe zone.");
    } finally {
      setIsSavingZone(false);
    }
  }

  function onSafeZoneDragStart() {
    setZoneUndoSnapshot({
      center: { ...center },
      radius_meters: radiusMeters,
    });
  }

  function onSafeZoneDragEnd() {
    setZonePopToken((current) => current + 1);
    setStatus("Safe zone center updated. Click Save to apply.");
  }

  function onUndoZoneDraft() {
    if (!zoneUndoSnapshot) {
      return;
    }
    setCenter({ ...zoneUndoSnapshot.center });
    setRadiusMeters(zoneUndoSnapshot.radius_meters);
    setZoneUndoSnapshot(null);
    setZonePopToken((current) => current + 1);
    setStatus("Reverted unsaved safe zone change.");
  }

  function toggleReminderDay(day: string) {
    setReminderDays((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day]
    );
  }

  function addReminderTime() {
    const candidates = ["08:00", "12:00", "18:00", "21:00", "06:00", "15:00", "07:00", "10:00", "14:00", "20:00"];
    setReminderTimes((current) => {
      const next = candidates.find((t) => !current.includes(t)) ?? "09:00";
      return [...current, next];
    });
  }

  function removeReminderTime(index: number) {
    setReminderTimes((current) => current.filter((_, i) => i !== index));
  }

  function updateReminderTime(index: number, value: string) {
    setReminderTimes((current) => current.map((v, i) => (i === index ? value : v)));
  }

  async function onAddReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!backendUrl) {
      setStatus("NEXT_PUBLIC_BACKEND_URL is missing.");
      return;
    }
    if (!reminderLabel.trim() || reminderTimes.length === 0 || reminderDays.length === 0) {
      setStatus("Label, at least one time, and at least one day are required.");
      return;
    }
    const hasDuplicates = reminderTimes.some((t, i) => reminderTimes.indexOf(t) !== i);
    if (hasDuplicates) {
      setStatus("Remove duplicate times before saving.");
      return;
    }

    setIsCreatingReminder(true);
    try {
      await Promise.all(
        reminderTimes.map((time) =>
          fetch(`${backendUrl}/reminders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              label: reminderLabel.trim(),
              time,
              days: reminderDays,
              active: true,
              dosage: reminderDosage.trim() || null
            })
          }).then((r) => { if (!r.ok) throw new Error("Create failed"); })
        )
      );

      await loadReminders();
      setReminderLabel("");
      setReminderDosage("");
      setReminderTimes(["09:00"]);
      setReminderDays([...WEEKDAYS]);
      setStatus("Reminder added.");
    } catch {
      setStatus("Could not add reminder.");
    } finally {
      setIsCreatingReminder(false);
    }
  }

  async function onDeleteReminder(reminderId: string) {
    if (!backendUrl) {
      setStatus("NEXT_PUBLIC_BACKEND_URL is missing.");
      return;
    }

    setIsDeletingReminderId(reminderId);
    try {
      const response = await fetch(`${backendUrl}/reminders/${reminderId}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Delete failed");
      }
      await loadReminders();
      setStatus("Reminder deleted.");
    } catch {
      setStatus("Could not delete reminder.");
    } finally {
      setIsDeletingReminderId(null);
    }
  }

  return (
    <>
      <header className="top-nav">
        <div className="brand">Clarity</div>
        <nav className="nav-tabs">
          <button className={`nav-tab ${activeTab === "family" ? "active" : ""}`} onClick={() => setActiveTab("family")} type="button">
            Family
          </button>
          <button className={`nav-tab ${activeTab === "zone" ? "active" : ""}`} onClick={() => setActiveTab("zone")} type="button">
            Safe Zone
          </button>
          <button className={`nav-tab ${activeTab === "reminders" ? "active" : ""}`} onClick={() => setActiveTab("reminders")} type="button">
            Reminders
          </button>
          <button className={`nav-tab ${activeTab === "room" ? "active" : ""}`} onClick={() => setActiveTab("room")} type="button">
            Room
          </button>
          <button className={`nav-tab ${activeTab === "log" ? "active" : ""}`} onClick={() => setActiveTab("log")} type="button">
            Live Log
          </button>
          <button className={`nav-tab ${activeTab === "conversation" ? "active" : ""}`} onClick={() => setActiveTab("conversation")} type="button">
            Conversation
          </button>
        </nav>
      </header>

      {showZoneBreachPopup && configuredZone ? (
        <aside className="zone-alert-popup" role="alert" aria-live="assertive">
          <p className="zone-alert-title">Safe Zone Alert</p>
          <p className="zone-alert-body">
            Patient is outside the safe zone by{" "}
            <strong>
              {Math.max(
                0,
                Math.round((distanceFromSafeZoneMeters || 0) - configuredZone.radius_meters)
              )}
              m
            </strong>
            .
          </p>
          <p className="zone-alert-meta">
            {isSendingBreachAlert ? "Sending alert..." : "Alert sent to caregiver log."}
          </p>
          <div className="zone-alert-actions">
            <button
              className="secondary-btn"
              onClick={() => setShowZoneBreachPopup(false)}
              type="button"
            >
              Dismiss
            </button>
          </div>
        </aside>
      ) : null}

      {alertPopup ? (
        <aside
          className={`reminder-alert-popup ${alertPopup.kind === "success" ? "success" : "warning"}`}
          role="alert"
          aria-live="assertive"
        >
          <p className="reminder-alert-title">{alertPopup.title}</p>
          <p className="reminder-alert-body">{alertPopup.body}</p>
          <div className="reminder-alert-actions">
            <button className="secondary-btn" onClick={() => setAlertPopup(null)} type="button">
              Dismiss
            </button>
          </div>
        </aside>
      ) : null}

      <main className="main-content">
        <p className="status-line">{status}</p>

        {activeTab === "family" ? (
          <>
            <section className="card">
              <h2 className="card-title">Family Members</h2>
              {family.length === 0 ? (
                <p className="family-empty">No family members added yet. Add one below to enable face recognition.</p>
              ) : (
                <div className="family-grid">
                  {family.map((member) => (
                    <article className="family-card" key={member.id}>
                      {member.photo_url ? (
                        <img alt={`${member.name} reference`} className="family-photo" src={member.photo_url} />
                      ) : (
                        <div className="family-photo placeholder" />
                      )}
                      <div className="family-meta">
                        <p className="family-name">{member.name}</p>
                        <p className="family-relationship">{member.relationship}</p>
                      </div>
                      <button
                        className="family-delete"
                        disabled={isDeletingFamilyId === member.id}
                        onClick={() => void onDeleteFamily(member)}
                        type="button"
                      >
                        {isDeletingFamilyId === member.id ? "Deleting..." : "Delete"}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="card upload-card">
              <h3 className="card-title">Add Family Reference</h3>
              <form onSubmit={onUploadFamily}>
                <div className="field-group">
                  <label className="field-label" htmlFor="family-name">
                    Name
                  </label>
                  <input
                    className="text-input"
                    id="family-name"
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Enter name"
                    value={name}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="family-relationship">
                    Relationship
                  </label>
                  <input
                    className="text-input"
                    id="family-relationship"
                    onChange={(event) => setRelationship(event.target.value)}
                    placeholder="Enter relationship"
                    value={relationship}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label">Photo</label>
                  <label
                    className={`upload-area${isDraggingPhoto ? " dragging" : ""}${photo ? " has-file" : ""}`}
                    htmlFor="family-photo"
                    onDragLeave={() => setIsDraggingPhoto(false)}
                    onDragOver={(e) => { e.preventDefault(); setIsDraggingPhoto(true); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDraggingPhoto(false);
                      const file = e.dataTransfer.files[0];
                      if (file) setPhoto(file);
                    }}
                  >
                    <input
                      accept="image/png,image/jpeg"
                      className="upload-input-hidden"
                      id="family-photo"
                      onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
                      type="file"
                    />
                    {photo ? photo.name : "Drop an image here or click to browse"}
                  </label>
                </div>
                <button className="primary-btn btn-block" disabled={isUploadingFamily} type="submit">
                  {isUploadingFamily ? "Uploading..." : "Add Family Member"}
                </button>
              </form>
            </section>
          </>
        ) : null}

        {activeTab === "zone" ? (
          <>
            <section className="card">
              <h2 className="card-title">Safe Zone</h2>
              <div className="address-search-wrapper" ref={addressWrapperRef}>
                <form className="address-search-row" onSubmit={onAddressFormSubmit}>
                  <input
                    autoComplete="off"
                    className="text-input"
                    onChange={(e) => onAddressInput(e.target.value)}
                    onFocus={() => { if (addressSuggestions.length > 0) setShowSuggestions(true); }}
                    placeholder="Search address or place name…"
                    value={addressQuery}
                  />
                  <button className="primary-btn" disabled={isGeocodingAddress} type="submit">
                    {isGeocodingAddress ? "…" : "Go"}
                  </button>
                </form>
                {showSuggestions && addressSuggestions.length > 0 ? (
                  <ul className="address-dropdown">
                    {addressSuggestions.map((result) => (
                      <li key={result.place_id}>
                        <button
                          className="address-dropdown-item"
                          onClick={() => onSelectSuggestion(result)}
                          type="button"
                        >
                          {result.display_name}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <SafeZoneMap
                center={center}
                flyTo={mapFlyTo}
                onCenterChange={(latitude, longitude) => setCenter({ latitude, longitude })}
                onCenterDragEnd={onSafeZoneDragEnd}
                onCenterDragStart={onSafeZoneDragStart}
                onFlyToConsumed={() => setMapFlyTo(null)}
                patientLocation={
                  patientLocation && patientLocation.latitude != null && patientLocation.longitude != null
                    ? { latitude: patientLocation.latitude, longitude: patientLocation.longitude }
                    : null
                }
                popToken={zonePopToken}
                radius={radiusMeters}
              />
            </section>

            <section className="card">
              <h3 className="card-title">Zone Radius</h3>
              <div className="zone-controls">
                <input
                  className="radius-slider"
                  max={500}
                  min={50}
                  onChange={(event) => {
                    setRadiusMeters(Number(event.target.value));
                    setZonePopToken((current) => current + 1);
                  }}
                  onMouseDown={() =>
                    setZoneUndoSnapshot({
                      center: { ...center },
                      radius_meters: radiusMeters,
                    })
                  }
                  onTouchStart={() =>
                    setZoneUndoSnapshot({
                      center: { ...center },
                      radius_meters: radiusMeters,
                    })
                  }
                  type="range"
                  value={radiusMeters}
                />
                <div className="radius-readout">{radiusMeters} meters</div>
              </div>
              <p className="coordinates">
                {`Center: ${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)}`}
              </p>
              <p className="coordinates">
                {patientLocation && patientLocation.latitude != null && patientLocation.longitude != null
                  ? `Patient: ${patientLocation.latitude.toFixed(6)}, ${patientLocation.longitude.toFixed(6)}`
                  : "Patient: waiting for phone location..."}
              </p>
              <div className="zone-actions">
                {zoneUndoSnapshot ? (
                  <button className="secondary-btn" onClick={onUndoZoneDraft} type="button">
                    Undo
                  </button>
                ) : null}
                <button className="primary-btn" disabled={isSavingZone} onClick={() => void onSaveSafeZone()} type="button">
                  {isSavingZone ? "Saving..." : "Save"}
                </button>
              </div>
            </section>
          </>
        ) : null}

        {activeTab === "reminders" ? (
          <div className="reminders-layout">
            <aside className="rem-sidebar">
              <p className="rem-sidebar-label">Medication Status</p>

              <div className="rem-status-block">
                {medicationDueStatus?.due ? (
                  <>
                    <span className="rem-status-badge rem-status-badge-pending">Due Now</span>
                    <p className="rem-status-med-name">
                      {String(medicationDueStatus.medication_name || medicationDueStatus.reminder_label || "Medication")}
                    </p>
                    <p className="rem-status-detail">{String(medicationDueStatus.reminder_time || "--:--")}</p>
                    <p className="rem-status-note">Awaiting bottle scan on phone</p>
                  </>
                ) : latestMedicationTakenEvent ? (
                  <>
                    <span className="rem-status-badge rem-status-badge-confirmed">Confirmed</span>
                    <p className="rem-status-med-name">
                      {String(latestMedicationTakenEvent.payload?.medication_name || latestMedicationTakenEvent.payload?.label || "Medication")}
                    </p>
                    <p className="rem-status-detail">Taken</p>
                    <p className="rem-status-note">
                      {displayTimestamp(
                        String(latestMedicationTakenEvent.payload?.timestamp || latestMedicationTakenEvent.created_at),
                        isHydrated
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <span className="rem-status-badge rem-status-badge-none">No Activity</span>
                    <p className="rem-status-med-name">—</p>
                    <p className="rem-status-note">Nothing logged yet</p>
                  </>
                )}
              </div>

              <div className="rem-sidebar-divider" />

              <p className="rem-sidebar-label">Today</p>
              {todaysReminders.length === 0 ? (
                <p className="rem-today-empty">No reminders today</p>
              ) : (
                <div className="rem-today-list">
                  {todaysReminders.map((reminder) => (
                    <div className="rem-today-item" key={reminder.id}>
                      <span className="rem-today-time">{reminder.time}</span>
                      <span className="rem-today-name">{reminder.label}</span>
                      {reminder.dosage ? <span className="rem-today-dosage">{reminder.dosage}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </aside>

            <div className="rem-main">
              <div className="rem-calendar-section">
                <p className="rem-section-label">Weekly Schedule</p>
                <div className="rem-calendar">
                  {calendarByDay.map(({ day, reminders: dayReminders }) => (
                    <div className={`rem-day-col${day === todayKey ? " rem-day-today" : ""}`} key={day}>
                      <div className="rem-day-header">{day.slice(0, 2).toUpperCase()}</div>
                      <div className="rem-day-body">
                        {dayReminders.map((reminder) => (
                          <div className="rem-chip" key={reminder.id}>
                            <p className="rem-chip-time">{reminder.time}</p>
                            <p className="rem-chip-name">{reminder.label}</p>
                            {reminder.dosage ? <p className="rem-chip-dosage">{reminder.dosage}</p> : null}
                            <button
                              className="rem-chip-delete"
                              disabled={isDeletingReminderId === reminder.id}
                              onClick={() => void onDeleteReminder(reminder.id)}
                              title="Delete"
                              type="button"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <section className="card">
                <h3 className="card-title">Add Reminder</h3>
                <form onSubmit={onAddReminder}>
                  <div className="field-group">
                    <label className="field-label" htmlFor="reminder-label">Label</label>
                    <input
                      className="text-input"
                      id="reminder-label"
                      onChange={(event) => setReminderLabel(event.target.value)}
                      placeholder="Medication name"
                      value={reminderLabel}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label" htmlFor="reminder-dosage">Dosage</label>
                    <input
                      className="text-input"
                      id="reminder-dosage"
                      onChange={(event) => setReminderDosage(event.target.value)}
                      placeholder="e.g. 2 pills, 50 mL"
                      value={reminderDosage}
                    />
                  </div>
                  <div className="field-group">
                    <label className="field-label">Times</label>
                    {reminderTimes.map((time, index) => {
                      const isDuplicate = reminderTimes.indexOf(time) !== index;
                      return (
                        <div className="time-row" key={index}>
                          <input
                            className={`time-input${isDuplicate ? " input-error" : ""}`}
                            onChange={(e) => updateReminderTime(index, e.target.value)}
                            type="time"
                            value={time}
                          />
                          {reminderTimes.length > 1 ? (
                            <button className="time-remove-btn" onClick={() => removeReminderTime(index)} type="button">×</button>
                          ) : null}
                        </div>
                      );
                    })}
                    <button className="add-time-btn" onClick={addReminderTime} type="button">+ Add time</button>
                  </div>
                  <div className="field-group">
                    <label className="field-label">Days</label>
                    <div className="day-preset-row">
                      <button className="day-preset-btn" onClick={() => setReminderDays([...EVERY_DAY])} type="button">Every day</button>
                      <button className="day-preset-btn" onClick={() => setReminderDays([...WEEKDAYS])} type="button">Weekdays</button>
                      <button className="day-preset-btn" onClick={() => setReminderDays([...WEEKEND])} type="button">Weekends</button>
                    </div>
                    <div className="day-toggle-row">
                      {DAY_OPTIONS.map((day) => {
                        const selected = reminderDays.includes(day);
                        return (
                          <button
                            className={`day-toggle ${selected ? "selected" : ""}`}
                            key={day}
                            onClick={() => toggleReminderDay(day)}
                            type="button"
                          >
                            {day.slice(0, 2).toUpperCase()}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button className="primary-btn btn-block-spaced" disabled={isCreatingReminder} type="submit">
                    {isCreatingReminder ? "Adding..." : "Add Reminder"}
                  </button>
                </form>
              </section>
            </div>
          </div>
        ) : null}

        {activeTab === "room" ? (
          <>
            <div style={{ marginBottom: "32px" }}>
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: "600",
                  color: "#444444",
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  marginBottom: "12px"
                }}
              >
                Patient environment
              </div>
              <RoomViewer
                flytoPill={flytoPill}
                pillDetected={pillDetected}
              />
            </div>
          </>
        ) : null}

        {activeTab === "log" ? (
          <>
            <div className="live-status">
              <span className={`live-dot ${isRealtimeConnected ? "live-dot-on" : "live-dot-off"}`} />
              <span>{isRealtimeConnected ? "Live" : "Reconnecting..."}</span>
            </div>
            <div
              style={{
                fontSize: "11px",
                fontWeight: "600",
                color: "#444444",
                letterSpacing: "1px",
                textTransform: "uppercase",
                marginBottom: "12px"
              }}
            >
              Event log
            </div>
            <section className="event-list">
              {events.length === 0 ? (
                <p className="status-line">No events yet.</p>
              ) : null}
              {events.map((event) => {
                const badge = eventBadge(event);
                const timestamp = String(event.payload?.timestamp || event.created_at || "");
                const enteringClass = freshEventIds.includes(event.id) ? "entering" : "";
                return (
                  <article className={`event-row ${enteringClass}`} key={event.id}>
                    <span className={`event-badge ${badge.className}`}>{badge.label}</span>
                    <div>
                      <p className="event-text">{eventText(event)}</p>
                      <p className="event-time">{displayTimestamp(timestamp, isHydrated)}</p>
                    </div>
                  </article>
                );
              })}
            </section>
          </>
        ) : null}

        {activeTab === "conversation" ? (
          <>
            <div className="conversation-status">
              <span className="conversation-status-dot" style={{ background: wakeWordListening ? "#22C55E" : "#666666" }} />
              <span>{wakeWordListening ? "Clarity is listening" : "Clarity is ready"}</span>
            </div>
            <section className="conversation-list" ref={conversationScrollRef}>
              {conversationTurns.length === 0 ? (
                <p className="status-line">No conversation turns yet.</p>
              ) : null}
              {conversationTurns.map((turn) => {
                const isAssistant = turn.role === "assistant";
                return (
                  <article
                    className={`conversation-row ${isAssistant ? "assistant" : "user"}`}
                    key={turn.id}
                  >
                    <p className={`conversation-author ${isAssistant ? "assistant" : "user"}`}>
                      {isAssistant ? "Clarity" : "Margaret"}
                    </p>
                    <div className={`conversation-bubble ${isAssistant ? "assistant" : "user"}`}>
                      <p className="conversation-text">{turn.content}</p>
                    </div>
                    <p className="conversation-time">{displayTimestamp(turn.created_at, isHydrated)}</p>
                  </article>
                );
              })}
            </section>
          </>
        ) : null}
      </main>
    </>
  );
}
