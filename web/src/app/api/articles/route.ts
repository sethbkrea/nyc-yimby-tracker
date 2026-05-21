import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadArticles } from "@/lib/articles";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const all = await loadArticles();
    // Newest first; strip the heavy body field from the list response.
    const sorted = [...all].sort((a, b) => (a.scraped_at < b.scraped_at ? 1 : -1));
    const preview = sorted.slice(0, 50).map(({ body, ...rest }) => rest);
    return NextResponse.json({ articles: preview, total: all.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
