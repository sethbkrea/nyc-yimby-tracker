import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/auth";
import { parseInputs, researchBatch, MAX_INPUTS } from "@/lib/research";
import { appendResearchLog, saveResearchRun } from "@/lib/github";

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

    const at = new Date().toISOString();
    const runId = randomUUID();
    const payload = {
      results,
      requested: inputs.length,
      processed: results.length,
      truncated,
      maxInputs: MAX_INPUTS,
    };

    // Persist full results (best-effort) then index the run in the audit log.
    // A logging/persistence failure must never break the search response.
    let savedRunId: string | undefined;
    try {
      await saveResearchRun(runId, { id: runId, at, user: session.user.email, inputs, ...payload });
      savedRunId = runId;
    } catch (saveErr) {
      console.error("[research-run] save failed:", saveErr);
    }
    try {
      await appendResearchLog({ at, user: session.user.email, count: inputs.length, inputs, runId: savedRunId });
    } catch (logErr) {
      console.error("[research-log] failed:", logErr);
    }

    return NextResponse.json({ ...payload, runId: savedRunId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
