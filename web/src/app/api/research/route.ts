import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { parseInputs, researchBatch, MAX_INPUTS } from "@/lib/research";
import { appendResearchLog } from "@/lib/github";

// Researching a batch fans out to GeoSearch + two Open Data datasets per input,
// so give it room beyond the default serverless timeout.
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await requireUser();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: string; inputs?: string[] };
    const raw = body.text ?? (Array.isArray(body.inputs) ? body.inputs.join("\n") : "");
    const inputs = parseInputs(raw);
    if (inputs.length === 0) {
      return NextResponse.json({ error: "No addresses or BBLs provided" }, { status: 400 });
    }
    const truncated = inputs.length > MAX_INPUTS;
    const results = await researchBatch(inputs);

    // Audit: record who searched which properties. Best-effort — never let a
    // logging failure break the search response.
    try {
      await appendResearchLog({
        at: new Date().toISOString(),
        user: session.user.email,
        count: inputs.length,
        inputs,
      });
    } catch (logErr) {
      console.error("[research-log] failed:", logErr);
    }

    return NextResponse.json({
      results,
      requested: inputs.length,
      processed: results.length,
      truncated,
      maxInputs: MAX_INPUTS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
