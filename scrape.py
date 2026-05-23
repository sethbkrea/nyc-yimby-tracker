"""Entrypoint: pull RSS feed, parse each new item, append to articles.json.

No Playwright, no per-article HTML fetch — Cloudflare blocks those on GitHub
Actions runners. RSS excerpts have enough detail for every structured field.

Environment variables:
  YIMBY_FEED_URL    RSS.app feed URL (required)
  ARTICLES_FILE     Path to JSON store (default: articles.json)
  MAX_AGE_DAYS      Skip feed items older than this (default: 30)
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

from extract import parse_rss_item
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
    print(f"[plan] {len(candidates)} new articles to add")
    if not candidates:
        return 0

    new_articles = [parse_rss_item(it) for it in candidates]
    appended = store.append(new_articles)
    print(f"[store] appended {appended} records")
    print(f"[done] {appended} appended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
