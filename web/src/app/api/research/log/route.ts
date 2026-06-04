import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadResearchLog } from "@/lib/github";

export async function GET() {
  const session = await requireUser();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const entries = await loadResearchLog(200);
    return NextResponse.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
