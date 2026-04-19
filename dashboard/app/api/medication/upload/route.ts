import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

const BUCKET = "medication-references";

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
    const medicationName = String(formData.get("medicationName") ?? "").trim();
    const file = formData.get("photo");

    if (!medicationName || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Medication name and reference photo are required." },
        { status: 400 }
      );
    }

    if (!["image/jpeg", "image/jpg", "image/png"].includes(file.type)) {
      return NextResponse.json(
        { error: "Reference photo must be a JPEG or PNG image." },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdminClient();
    const medicationSlug = slugify(medicationName) || "medication";
    const safeFileName = slugify(file.name.replace(/\.[^/.]+$/, "")) || "photo";
    const extension = file.type.includes("png") ? "png" : "jpg";
    const photoPath = `${medicationSlug}/${Date.now()}-${safeFileName}.${extension}`;

    const arrayBuffer = await file.arrayBuffer();
    const upload = await supabase.storage.from(BUCKET).upload(photoPath, Buffer.from(arrayBuffer), {
      contentType: file.type
    });
    if (upload.error) {
      return NextResponse.json({ error: upload.error.message }, { status: 500 });
    }

    const signed = await supabase.storage.from(BUCKET).createSignedUrl(photoPath, 60 * 60);
    return NextResponse.json({
      reference_photo_path: photoPath,
      reference_photo_bucket: BUCKET,
      reference_photo_url: signed.data?.signedUrl ?? null
    });
  } catch {
    return NextResponse.json({ error: "Medication photo upload failed." }, { status: 500 });
  }
}
