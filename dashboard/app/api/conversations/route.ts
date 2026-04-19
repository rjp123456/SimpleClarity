import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get("limit") ?? "200");
  const limit = Math.min(Math.max(requestedLimit, 1), 500);

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("conversations")
      .select("id, role, content, created_at")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data ?? []);
  } catch {
    return NextResponse.json({ error: "Could not load conversations." }, { status: 500 });
  }
}
