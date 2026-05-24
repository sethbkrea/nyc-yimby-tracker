import { NextResponse } from "next/server";
import { listRecentRuns, loadRunSummaries } from "@/lib/github";

export async function GET() {
  try {
    const [runs, summaries] = await Promise.all([listRecentRuns(15), loadRunSummaries()]);
    const summaryById = new Map(summaries.map((s) => [s.run_id, s]));

    return NextResponse.json({
      runs: runs.map((r) => {
        const s = summaryById.get(r.id);
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          url: r.html_url,
          event: r.event,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          path: r.path,
          articlesAdded: s?.articles_added ?? null,
          articlesFailed: s?.articles_failed ?? null,
        };
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
