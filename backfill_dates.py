"""Backfill the real PUBLISH date onto every article in articles.json.

The corpus only stores `scraped_at` (the pull date). This adds `published`
(ISO datetime from each article page's <meta property="article:published_time">)
so the tracker can filter by when YIMBY actually published, not when we scraped.

Free — no LLM calls, just a page fetch + regex. Uses Playwright (gets past
Cloudflare from a local IP). Resumable: only fetches articles missing `published`,
writes to disk every batch, safe to interrupt and re-run.

Usage:
  .venv/bin/python backfill_dates.py            # all missing
  .venv/bin/python backfill_dates.py --limit 50 # smoke test
"""
from __future__ import annotations

import argparse
import json
import re
import sys

from article import FetchError, browser_session, fetch_article

ARTICLES = "articles.json"
PUB_RE = re.compile(r'article:published_time"\s+content="([^"]+)"')
BATCH = 25


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    data = json.load(open(ARTICLES))
    todo = [a for a in data if a.get("url") and not a.get("published")]
    if args.limit:
        todo = todo[: args.limit]
    print(f"[dates] {len(todo)} articles missing publish date (of {len(data)})")
    if not todo:
        return 0

    done = 0
    with browser_session() as browser:
        for i, art in enumerate(todo, 1):
            url = art["url"]
            try:
                html = fetch_article(browser, url)
                m = PUB_RE.search(html)
                if m:
                    art["published"] = m.group(1)
                    done += 1
                    print(f"[{i}/{len(todo)}] {art['published'][:10]}  {url.split('/')[-1][:50]}")
                else:
                    art["published"] = None
                    print(f"[{i}/{len(todo)}] no date  {url.split('/')[-1][:50]}", file=sys.stderr)
            except FetchError as e:
                print(f"[{i}/{len(todo)}] FETCH FAIL {e}", file=sys.stderr)
            if i % BATCH == 0:
                json.dump(data, open(ARTICLES, "w"), indent=2)
                print(f"  …saved ({i} processed)")

    json.dump(data, open(ARTICLES, "w"), indent=2)
    print(f"[dates] done — set publish date on {done} articles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
