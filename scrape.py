"""Entrypoint: pull RSS feed, fetch new articles via Playwright, append to articles.json.

Environment variables:
  YIMBY_FEED_URL    RSS.app feed URL (required)
  ARTICLES_FILE     Path to JSON store (default: articles.json)
  MAX_AGE_DAYS      Skip feed items older than this (default: 30)
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone

from article import browser_session, fetch_article
from extract import parse_article
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
    print(f"[plan] {len(candidates)} new articles to scrape")
    if not candidates:
        return 0

    new_articles = []
    failures: list[tuple[str, str]] = []
    with browser_session() as browser:
        for i, item in enumerate(candidates, 1):
            print(f"[{i}/{len(candidates)}] {item.url}")
            try:
                html = fetch_article(browser, item.url)
                new_articles.append(parse_article(html, item.url))
            except Exception as exc:  # noqa: BLE001
                print(f"  failed: {exc}", file=sys.stderr)
                failures.append((item.url, str(exc)))
            time.sleep(1.5)

    appended = store.append(new_articles)
    print(f"[store] appended {appended} records")

    if failures:
        print(f"[done] {appended} appended, {len(failures)} failed", file=sys.stderr)
        return 1
    print(f"[done] {appended} appended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
