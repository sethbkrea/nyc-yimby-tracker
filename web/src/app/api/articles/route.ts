import { NextResponse } from "next/server";
import { loadArticles } from "@/lib/articles";

export async function GET() {
  try {
    const all = await loadArticles();
    const sorted = [...all].sort((a, b) => (a.scraped_at < b.scraped_at ? 1 : -1));
    const preview = sorted.slice(0, 50).map(({ body, ...rest }) => rest);
    return NextResponse.json({ articles: preview, total: all.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
