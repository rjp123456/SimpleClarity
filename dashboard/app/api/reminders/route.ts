import { NextResponse } from "next/server";
import { getBackendUrlFromEnv, getSupabaseAdminClient } from "@/lib/supabase-admin";

type ReminderRecord = {
  id: string;
  label: string;
  time: string;
  days: string[];
  active: boolean;
  medication_name?: string | null;
  reference_photo_path?: string | null;
  reference_photo_bucket?: string | null;
};

export async function GET() {
  const backendUrl = getBackendUrlFromEnv();
  if (!backendUrl) {
    return NextResponse.json({ error: "Backend URL is not configured." }, { status: 500 });
  }

  try {
    const response = await fetch(`${backendUrl}/reminders`, { cache: "no-store" });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return NextResponse.json(
        { error: detail || "Could not load reminders from backend." },
        { status: response.status }
      );
    }

    const reminders = (await response.json()) as ReminderRecord[];
    const supabase = getSupabaseAdminClient();

    const enriched = await Promise.all(
      (reminders || []).map(async (reminder) => {
        const photoPath = String(reminder.reference_photo_path ?? "").trim();
        const bucket = String(reminder.reference_photo_bucket ?? "medication-references").trim();
        if (!photoPath) {
          return {
            ...reminder,
            reference_photo_url: null
          };
        }

        const signed = await supabase.storage.from(bucket).createSignedUrl(photoPath, 60 * 60);
        return {
          ...reminder,
          reference_photo_url: signed.data?.signedUrl ?? null
        };
      })
    );

    return NextResponse.json(enriched);
  } catch {
    return NextResponse.json({ error: "Could not load reminders." }, { status: 500 });
  }
}
