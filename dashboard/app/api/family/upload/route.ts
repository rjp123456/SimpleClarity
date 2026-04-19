import { NextResponse } from "next/server";
import { getBackendUrlFromEnv, getSupabaseAdminClient } from "@/lib/supabase-admin";

const BUCKET = "face-references";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const name = String(formData.get("name") ?? "").trim();
    const relationship = String(formData.get("relationship") ?? "").trim();
    const file = formData.get("photo");

    if (!name || !relationship || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Name, relationship, and photo are required." },
        { status: 400 }
      );
    }

    if (!["image/jpeg", "image/jpg", "image/png"].includes(file.type)) {
      return NextResponse.json({ error: "Photo must be a JPEG or PNG image." }, { status: 400 });
    }

    const supabase = getSupabaseAdminClient();
    const nameSlug = slugify(name) || "unknown";
    const relationshipSlug = slugify(relationship) || "family";
    const safeFileName = slugify(file.name.replace(/\.[^/.]+$/, "")) || "photo";
    const extension = file.type.includes("png") ? "png" : "jpg";
    const photoPath = `${nameSlug}_${relationshipSlug}/${Date.now()}-${safeFileName}.${extension}`;

    const arrayBuffer = await file.arrayBuffer();
    const upload = await supabase.storage.from(BUCKET).upload(photoPath, Buffer.from(arrayBuffer), {
      contentType: file.type
    });
    if (upload.error) {
      return NextResponse.json({ error: upload.error.message }, { status: 500 });
    }

    const insert = await supabase
      .from("face_references")
      .insert({
        name,
        relationship,
        photo_path: photoPath
      })
      .select("id, name, relationship, photo_path, created_at")
      .single();

    if (insert.error) {
      return NextResponse.json({ error: insert.error.message }, { status: 500 });
    }

    let syncResult: unknown = null;
    const backendUrl = getBackendUrlFromEnv();
    if (backendUrl) {
      try {
        const syncResponse = await fetch(`${backendUrl}/sync-faces`, { method: "POST" });
        if (syncResponse.ok) {
          syncResult = await syncResponse.json();
        }
      } catch {
        syncResult = { synced: 0 };
      }
    }

    const signed = await supabase.storage.from(BUCKET).createSignedUrl(photoPath, 60 * 60);
    return NextResponse.json({
      ...insert.data,
      photo_url: signed.data?.signedUrl ?? null,
      sync: syncResult
    });
  } catch {
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}
