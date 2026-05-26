"""Sitemap-based verification and (optional) backfill.

1. Fetches YIMBY's wp-sitemap.xml index and every child sitemap.
2. Filters to article URLs in the requested date range.
3. Diffs against articles.json — prints per-month "sitemap: X, captured: Y, missing: Z".
4. If --backfill, runs the missing URLs through Playwright + Claude and appends.

Usage:
  export ANTHROPIC_API_KEY=sk-ant-...
  python verify_and_backfill.py --start 2025-08 --end 2026-05            # report only
  python verify_and_backfill.py --start 2025-08 --backfill               # report + fix
  python verify_and_backfill.py --start 2025-08 --backfill --limit 5     # smoke test
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from xml.etree import ElementTree as ET

from article import FetchError, browser_session, fetch_article, fetch_xml
from extract_llm import llm_parse_article_html
from store import Store

NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
ARTICLE_RE = re.compile(r"^https?://newyorkyimby\.com/(\d{4})/(\d{2})/[a-z0-9-]+\.html$")

# robots.txt advertises /wp-sitemap.xml but that path 404s on the actual server.
# Try common WP / Yoast / RankMath locations in order; first valid XML wins.
SITEMAP_CANDIDATES = [
    "https://newyorkyimby.com/wp-sitemap.xml",
    "https://newyorkyimby.com/sitemap_index.xml",
    "https://newyorkyimby.com/sitemap.xml",
    "https://newyorkyimby.com/post-sitemap.xml",
    "https://newyorkyimby.com/post-sitemap1.xml",
    "https://newyorkyimby.com/sitemap-index.xml",
]


def _try_sitemap_url(browser, url: str) -> str | None:
    try:
        xml = fetch_xml(browser, url)
        # Cheap sanity check — it should at least look like XML
        if "<?xml" in xml[:200] or "<urlset" in xml[:500] or "<sitemapindex" in xml[:500]:
            print(f"[sitemap] using {url}")
            return xml
    except FetchError as exc:
        print(f"[sitemap] {url} → {exc}", file=sys.stderr)
    return None

BATCH_SIZE = 25


def _parse_yyyy_mm(s: str) -> tuple[int, int]:
    y, m = s.split("-")
    return int(y), int(m)


def _in_range(year: int, month: int, start: tuple[int, int], end: tuple[int, int]) -> bool:
    return start <= (year, month) <= end


def _list_post_sitemaps(index_xml: str) -> list[str]:
    """Pull every <loc> from the sitemap index whose URL looks like posts."""
    root = ET.fromstring(index_xml)
    urls = []
    for loc in root.findall(".//sm:sitemap/sm:loc", NS):
        if loc.text and "post" in loc.text.lower():
            urls.append(loc.text.strip())
    return urls


def _extract_article_urls(sitemap_xml: str, start: tuple[int, int], end: tuple[int, int]) -> list[str]:
    """Parse a <urlset> sitemap and return article URLs whose YYYY/MM is in range."""
    root = ET.fromstring(sitemap_xml)
    urls = []
    for loc in root.findall(".//sm:url/sm:loc", NS):
        if not loc.text:
            continue
        url = loc.text.strip()
        m = ARTICLE_RE.match(url)
        if not m:
            continue
        y, mo = int(m.group(1)), int(m.group(2))
        if _in_range(y, mo, start, end):
            urls.append(url)
    return urls


def discover_urls(browser, start: tuple[int, int], end: tuple[int, int]) -> list[str]:
    print("[sitemap] probing known sitemap locations…")
    index_xml: str | None = None
    found_url: str | None = None
    for candidate in SITEMAP_CANDIDATES:
        xml = _try_sitemap_url(browser, candidate)
        if xml is not None:
            index_xml = xml
            found_url = candidate
            break
        time.sleep(1)

    if index_xml is None:
        raise FetchError(
            "no working sitemap found at any common path. "
            "YIMBY may have disabled sitemap generation. "
            "Fall back to backfill.py (archive crawl) for what's available."
        )

    # Two possible shapes: <sitemapindex> (list of child sitemaps) or
    # <urlset> (direct list of URLs).
    if "<sitemapindex" in index_xml[:500]:
        post_sitemaps = _list_post_sitemaps(index_xml)
        print(f"[sitemap] {len(post_sitemaps)} child post sitemaps")
        all_urls: set[str] = set()
        for sm_url in post_sitemaps:
            try:
                xml = fetch_xml(browser, sm_url)
            except FetchError as exc:
                print(f"  [warn] {sm_url}: {exc}", file=sys.stderr)
                continue
            urls = _extract_article_urls(xml, start, end)
            all_urls.update(urls)
            print(f"  {sm_url.rsplit('/', 1)[-1]}: {len(urls)} in-range URLs")
            time.sleep(0.5)
        return sorted(all_urls)
    else:
        # Direct <urlset> — extract everything in one shot.
        urls = _extract_article_urls(index_xml, start, end)
        print(f"[sitemap] {len(urls)} in-range URLs from {found_url}")
        return sorted(set(urls))


def report(captured: set[str], from_sitemap: list[str]) -> dict[str, dict]:
    """Group by YYYY-MM and report sitemap vs captured."""
    sitemap_by_month: dict[str, set[str]] = defaultdict(set)
    captured_by_month: dict[str, set[str]] = defaultdict(set)
    for url in from_sitemap:
        m = ARTICLE_RE.match(url)
        if m:
            sitemap_by_month[f"{m.group(1)}-{m.group(2)}"].add(url)
    for url in captured:
        m = ARTICLE_RE.match(url)
        if m:
            captured_by_month[f"{m.group(1)}-{m.group(2)}"].add(url)

    rows = {}
    print()
    print(f"{'Month':<10}  {'Sitemap':>8}  {'Captured':>8}  {'Missing':>8}")
    print("-" * 42)
    total_missing = 0
    for month in sorted(sitemap_by_month):
        s = sitemap_by_month[month]
        c = captured_by_month.get(month, set())
        missing = sorted(s - c)
        total_missing += len(missing)
        print(f"{month:<10}  {len(s):>8}  {len(c & s):>8}  {len(missing):>8}")
        rows[month] = {"missing": missing}
    print("-" * 42)
    print(f"{'TOTAL':<10}  {sum(len(v) for v in sitemap_by_month.values()):>8}  "
          f"{sum(len(captured_by_month.get(m, set()) & s) for m, s in sitemap_by_month.items()):>8}  "
          f"{total_missing:>8}")
    return rows


def backfill_missing(browser, store: Store, missing_urls: list[str], limit: int | None) -> int:
    if limit:
        missing_urls = missing_urls[:limit]
    if not missing_urls:
        return 0
    print(f"\n[backfill] processing {len(missing_urls)} missing articles via Claude")
    batch: list[dict] = []
    failures: list[tuple[str, str]] = []
    t0 = time.time()
    for i, url in enumerate(missing_urls, 1):
        eta = (time.time() - t0) / max(i - 1, 1) * (len(missing_urls) - i)
        print(f"  [{i}/{len(missing_urls)}] ({eta/60:.1f}m eta) {url}")
        try:
            html = fetch_article(browser, url)
            now_iso = datetime.now(timezone.utc).isoformat()
            article = llm_parse_article_html(html, url, now_iso)
            batch.append(article.as_record())
        except Exception as exc:  # noqa: BLE001
            print(f"    failed: {exc}", file=sys.stderr)
            failures.append((url, str(exc)))
        if len(batch) >= BATCH_SIZE:
            store.append_records(batch)
            print(f"  [store] appended {len(batch)} records")
            batch.clear()
        time.sleep(1.5)
    if batch:
        store.append_records(batch)
        print(f"  [store] appended {len(batch)} final records")
    if failures:
        print(f"[backfill] {len(failures)} failed", file=sys.stderr)
    return len(missing_urls) - len(failures)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM (inclusive)")
    ap.add_argument("--end", default=None, help="YYYY-MM (inclusive). Defaults to current month.")
    ap.add_argument("--backfill", action="store_true", help="Process missing URLs through Claude")
    ap.add_argument("--limit", type=int, default=None, help="Cap backfill to N URLs (smoke test)")
    args = ap.parse_args()

    if args.backfill and not os.environ.get("ANTHROPIC_API_KEY"):
        print("error: ANTHROPIC_API_KEY required for --backfill", file=sys.stderr)
        return 2

    start = _parse_yyyy_mm(args.start)
    end = _parse_yyyy_mm(args.end) if args.end else (date.today().year, date.today().month)

    store = Store()
    captured = store.existing_links()
    print(f"[store] {len(captured)} existing articles")

    with browser_session() as browser:
        sitemap_urls = discover_urls(browser, start, end)
        print(f"\n[sitemap] {len(sitemap_urls)} article URLs in range {start[0]}-{start[1]:02d} → {end[0]}-{end[1]:02d}")

        per_month = report(captured, sitemap_urls)
        missing_urls = [u for urls in per_month.values() for u in urls["missing"]]

        # Always dump missing URLs to a file so the user has a list even if not backfilling.
        with open("missing_urls.txt", "w") as f:
            for u in missing_urls:
                f.write(u + "\n")
        print(f"\n[file] wrote {len(missing_urls)} URLs to missing_urls.txt")

        if not missing_urls:
            print("✓ nothing missing")
            return 0

        if not args.backfill:
            print("\nRun with --backfill to fetch and extract the missing articles via Claude.")
            return 0

        added = backfill_missing(browser, store, missing_urls, args.limit)
        print(f"\n[done] added {added} articles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
