import { NextResponse } from "next/server";
import { dispatchWorkflow } from "@/lib/github";

const ALLOWED = new Set([
  ["daily-scrape.yml", new Set<string>()],
  ["backfill.yml", new Set(["start_month", "end_month", "dry_run"])],
] as const);

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.workflow !== "string") {
    return NextResponse.json({ error: "Missing workflow" }, { status: 400 });
  }

  const allowedEntry = [...ALLOWED].find(([w]) => w === body.workflow);
  if (!allowedEntry) {
    return NextResponse.json({ error: "Unknown workflow" }, { status: 400 });
  }
  const [workflow, allowedKeys] = allowedEntry;

  const inputs: Record<string, string | boolean> = {};
  if (body.inputs && typeof body.inputs === "object") {
    for (const [k, v] of Object.entries(body.inputs)) {
      if (!allowedKeys.has(k)) continue;
      if (typeof v === "string" || typeof v === "boolean") inputs[k] = v;
    }
  }

  try {
    await dispatchWorkflow(workflow, inputs);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
