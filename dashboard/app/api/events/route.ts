import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get("limit") ?? "100");
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("events")
      .select("id, type, payload, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data ?? []);
  } catch {
    return NextResponse.json({ error: "Could not load event log." }, { status: 500 });
  }
}
