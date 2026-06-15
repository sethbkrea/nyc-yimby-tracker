"""Enrich articles.json with related news coverage from Google News RSS.

For each unique address in articles.json, queries Google News for additional
articles mentioning that address. Stores results in related_news.json,
keyed by address. Dedupes by URL across runs.

Free path — Google News RSS has no key requirement. Rate-limited politely
to avoid getting throttled (1 second between queries).

Usage:
  python enrich_news.py                       # refresh every address
  python enrich_news.py --since 30            # only addresses scraped in last 30 days
  python enrich_news.py --limit 5             # smoke test on 5 addresses
  python enrich_news.py --address "38 East 35th Street"   # one address
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
from dateutil import parser as dateparser

ARTICLES_FILE = Path("articles.json")
NEWS_FILE = Path("related_news.json")

# Google News wraps every URL in their own redirect (news.google.com/rss/articles/<base64>),
# so the underlying domain isn't visible. Filter by SOURCE NAME instead — Google News
# RSS includes the publisher name on each item.
EXCLUDED_SOURCE_KEYWORDS = {
    "yimby",
    "youtube",
    "reddit",
    "facebook",
    "twitter",
    "x.com",
}

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

DELAY_BETWEEN_QUERIES_S = 1.0


def _read_json(path: Path, default):
    if not path.exists() or path.stat().st_size == 0:
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def _query_google_news_rss(query: str) -> bytes:
    """Hit Google News RSS for a search query. Returns raw XML bytes."""
    qs = urllib.parse.urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    url = f"https://news.google.com/rss/search?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _hostname(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return ""


def _strip_html(s: str) -> str:
    if not s:
        return ""
    text = re.sub(r"<[^>]+>", " ", s)
    # Replace &nbsp;, &amp;, etc.
    import html as _html
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _is_meaningful_address(addr: str) -> bool:
    """Skip blank, too-short, or non-specific addresses ('Park Avenue between 14th and 15th')."""
    if not addr or len(addr.strip()) < 6:
        return False
    # Require at least one digit (real addresses are numbered).
    if not re.search(r"\d", addr):
        return False
    # Skip very generic 'Block X' style entries.
    if re.match(r"^block\s+\d+$", addr.lower()):
        return False
    return True


def collect_addresses(articles: list[dict], since_days: int | None = None) -> list[str]:
    """Return a deduped list of meaningful addresses, optionally filtered by recency."""
    cutoff = None
    if since_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
    seen: set[str] = set()
    addresses: list[str] = []
    for a in articles:
        addr = (a.get("address") or "").strip()
        if not _is_meaningful_address(addr):
            continue
        if cutoff:
            try:
                scraped = dateparser.parse(a.get("scraped_at") or "")
                if scraped and scraped < cutoff:
                    continue
            except (ValueError, TypeError):
                pass
        if addr.lower() in seen:
            continue
        seen.add(addr.lower())
        addresses.append(addr)
    return addresses


def fetch_news_for_address(address: str) -> list[dict]:
    """Query Google News for one address and return a list of normalized records."""
    # Include 'New York' to bias toward NYC-specific results.
    query = f'"{address}" New York'
    try:
        raw = _query_google_news_rss(query)
    except Exception as exc:  # noqa: BLE001
        print(f"  [warn] query failed: {exc}", file=sys.stderr)
        return []
    parsed = feedparser.parse(raw)
    results = []
    for entry in parsed.entries:
        link = entry.get("link", "")
        if not link:
            continue
        pub = ""
        if entry.get("published"):
            try:
                pub_dt = dateparser.parse(entry["published"])
                if pub_dt.tzinfo is None:
                    pub_dt = pub_dt.replace(tzinfo=timezone.utc)
                pub = pub_dt.astimezone(timezone.utc).isoformat()
            except (ValueError, TypeError):
                pass
        # Google News RSS source name lives in entry.source.title typically.
        source = ""
        if hasattr(entry, "source") and entry.source:
            source = entry.source.get("title", "") if isinstance(entry.source, dict) else getattr(entry.source, "title", "")
        if not source:
            source = _hostname(link)
        source = source.strip()
        # Skip publishers we already cover or don't want.
        slc = source.lower()
        if any(kw in slc for kw in EXCLUDED_SOURCE_KEYWORDS):
            continue
        # Title from Google News includes " - PublisherName" suffix; strip it.
        title = (entry.get("title") or "").strip()
        title = re.sub(rf"\s*[-–]\s*{re.escape(source)}\s*$", "", title) if source else title
        results.append({
            "address": address,
            "title": title,
            "url": link,
            "source": source,
            "published": pub,
            "snippet": _strip_html(entry.get("summary") or ""),
        })
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=None, help="Only addresses scraped in last N days")
    ap.add_argument("--limit", type=int, default=None, help="Cap N addresses (smoke test)")
    ap.add_argument("--address", default=None, help="Process one specific address")
    args = ap.parse_args()

    articles = _read_json(ARTICLES_FILE, [])
    if not isinstance(articles, list):
        print("error: articles.json must be a list", file=sys.stderr)
        return 2

    if args.address:
        addresses = [args.address]
    else:
        addresses = collect_addresses(articles, since_days=args.since)
        if args.limit:
            addresses = addresses[: args.limit]

    print(f"[plan] {len(addresses)} addresses to query")

    store = _read_json(NEWS_FILE, {"articles": [], "address_refresh_dates": {}})
    if not isinstance(store, dict):
        store = {"articles": [], "address_refresh_dates": {}}
    store.setdefault("articles", [])
    store.setdefault("address_refresh_dates", {})

    # Build dedup index on URL.
    existing_urls = {r.get("url") for r in store["articles"] if r.get("url")}
    print(f"[store] {len(store['articles'])} existing related-news records")

    now_iso = datetime.now(timezone.utc).isoformat()
    added = 0
    failed = 0
    for i, addr in enumerate(addresses, 1):
        print(f"[{i}/{len(addresses)}] {addr}")
        try:
            found = fetch_news_for_address(addr)
        except Exception as exc:  # noqa: BLE001
            print(f"  [error] {exc}", file=sys.stderr)
            failed += 1
            time.sleep(DELAY_BETWEEN_QUERIES_S)
            continue
        new_for_addr = 0
        for rec in found:
            if rec["url"] in existing_urls:
                continue
            rec["fetched_at"] = now_iso
            store["articles"].append(rec)
            existing_urls.add(rec["url"])
            new_for_addr += 1
            added += 1
        store["address_refresh_dates"][addr] = now_iso
        if new_for_addr:
            print(f"  + {new_for_addr} new")
        time.sleep(DELAY_BETWEEN_QUERIES_S)

        # Flush to disk every 50 addresses so a crash doesn't lose everything.
        if i % 50 == 0:
            _write_json(NEWS_FILE, store)

    _write_json(NEWS_FILE, store)

    # Expose counts to GitHub Actions for the commit message.
    import os
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(f"added={added}\n")
            f.write(f"addresses_queried={len(addresses)}\n")
            f.write(f"failed={failed}\n")

    print(f"[done] +{added} related news records ({failed} address queries failed)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
