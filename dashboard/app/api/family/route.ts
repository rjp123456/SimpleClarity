import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

const BUCKET = "face-references";

export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("face_references")
      .select("id, name, relationship, photo_path, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const references = await Promise.all(
      (data ?? []).map(async (reference) => {
        const photoPath = String(reference.photo_path ?? "");
        if (!photoPath) {
          return { ...reference, photo_url: null };
        }

        const signed = await supabase.storage.from(BUCKET).createSignedUrl(photoPath, 60 * 60);
        return {
          ...reference,
          photo_url: signed.data?.signedUrl ?? null
        };
      })
    );

    return NextResponse.json(references);
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch family photos." }, { status: 500 });
  }
}
