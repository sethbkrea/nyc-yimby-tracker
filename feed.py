"""Parse the RSS.app feed into items (url, pub_datetime, title, description)."""
from __future__ import annotations

import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

import feedparser
from dateutil import parser as dateparser


@dataclass
class FeedItem:
    url: str
    published: datetime  # tz-aware UTC
    title: str
    description: str  # raw HTML — strip in extract.py


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def load_feed(feed_url: str) -> list[FeedItem]:
    raw = _fetch(feed_url)
    parsed = feedparser.parse(raw)
    items: list[FeedItem] = []
    for entry in parsed.entries:
        link = entry.get("link")
        if not link:
            continue
        pub = None
        if entry.get("published"):
            try:
                pub = dateparser.parse(entry["published"])
            except (ValueError, TypeError):
                pub = None
        if pub is None:
            continue
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)
        items.append(
            FeedItem(
                url=link,
                published=pub.astimezone(timezone.utc),
                title=entry.get("title", "") or "",
                description=entry.get("summary", "") or entry.get("description", "") or "",
            )
        )
    return items
