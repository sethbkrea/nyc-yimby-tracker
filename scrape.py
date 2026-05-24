"""Entrypoint: pull RSS feed, run each new item through Claude, append to articles.json.

One Claude call per new article. No browser, no Cloudflare. Works on RSS excerpts
today; when RSS.app's Full Article Extraction is enabled the feed delivers full
HTML in <content:encoded> and the same code automatically gets richer extractions.

Environment variables:
  YIMBY_FEED_URL      RSS.app feed URL (required)
  ANTHROPIC_API_KEY   for LLM extraction (required)
  CLAUDE_MODEL        override default model (optional)
  ARTICLES_FILE       path to JSON store (default: articles.json)
  MAX_AGE_DAYS        skip feed items older than this (default: 30)
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

from extract_llm import llm_parse_item
from feed import load_feed
from store import Store


def _env(name: str, default: str | None = None, required: bool = False) -> str:
    val = os.environ.get(name, default)
    if required and not val:
        print(f"error: ${name} is required", file=sys.stderr)
        sys.exit(2)
    return val or ""


def main() -> int:
    feed_url = _env("YIMBY_FEED_URL", required=True)
    _env("ANTHROPIC_API_KEY", required=True)  # checked here for early failure
    max_age_days = int(_env("MAX_AGE_DAYS", "30"))

    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)

    store = Store()
    seen = store.existing_links()
    print(f"[store] {len(seen)} existing articles")

    feed_items = load_feed(feed_url)
    print(f"[feed] {len(feed_items)} items")

    candidates = sorted(
        (it for it in feed_items if it.url not in seen and it.published >= cutoff),
        key=lambda it: it.published,
    )
    print(f"[plan] {len(candidates)} new articles to extract")
    if not candidates:
        return 0

    now_iso = datetime.now(timezone.utc).isoformat()
    new_records: list[dict] = []
    failures: list[tuple[str, str]] = []
    for i, item in enumerate(candidates, 1):
        print(f"[{i}/{len(candidates)}] {item.url}")
        try:
            article = llm_parse_item(item, scraped_at=now_iso)
            new_records.append(article.as_record())
        except Exception as exc:  # noqa: BLE001
            print(f"  failed: {exc}", file=sys.stderr)
            failures.append((item.url, str(exc)))

    appended = store.append_records(new_records)
    print(f"[store] appended {appended} records")

    if failures:
        print(f"[done] {appended} appended, {len(failures)} failed", file=sys.stderr)
        return 1
    print(f"[done] {appended} appended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
