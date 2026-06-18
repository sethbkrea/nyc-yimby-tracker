"""One-off historical backfill. Crawls /YYYY/MM/page/N/ archives via Playwright,
extracts each missing article through Claude, appends to articles.json.

INTENDED TO RUN LOCALLY (not in GitHub Actions). GitHub's IPs are flagged by
Cloudflare so Playwright never gets past the JS challenge from there; from a
home/office IP it works fine.

Usage (from the repo root):
  export ANTHROPIC_API_KEY=sk-ant-...
  python backfill.py --start 2025-08
  python backfill.py --start 2025-08 --end 2026-05
  python backfill.py --start 2025-08 --dry-run

Safe to interrupt: each batch is written to disk immediately and re-running
skips URLs already present.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import date, datetime, timezone

from bs4 import BeautifulSoup

from article import FetchError, browser_session, fetch_archive, fetch_article
from extract_llm import llm_parse_article_html, cache_stats
from store import Store

ARTICLE_RE = re.compile(r"https?://newyorkyimby\.com/(\d{4})/(\d{2})/[a-z0-9-]+\.html$")
TOTAL_PAGES_RE = re.compile(r"Page\s+\d+\s+of\s+(\d+)", re.IGNORECASE)

BATCH_SIZE = 25


def _iter_months(start: tuple[int, int], end: tuple[int, int]):
    y, m = start
    while (y, m) <= end:
        yield y, m
        m += 1
        if m == 13:
            m = 1
            y += 1


def _parse_yyyy_mm(s: str) -> tuple[int, int]:
    y, m = s.split("-")
    return int(y), int(m)


def collect_month_urls(browser, year: int, month: int) -> list[str]:
    base = f"https://newyorkyimby.com/{year}/{month:02d}/"
    print(f"[{year}-{month:02d}] crawling archive…")

    first_html = fetch_archive(browser, base)
    soup = BeautifulSoup(first_html, "lxml")
    title = soup.title.string if soup.title else ""
    total_pages = 1
    m = TOTAL_PAGES_RE.search(title)
    if m:
        total_pages = int(m.group(1))
    else:
        try:
            page2 = fetch_archive(browser, base + "page/2/")
            soup2 = BeautifulSoup(page2, "lxml")
            title2 = soup2.title.string if soup2.title else ""
            m2 = TOTAL_PAGES_RE.search(title2)
            if m2:
                total_pages = int(m2.group(1))
        except FetchError:
            pass

    print(f"[{year}-{month:02d}] {total_pages} archive page(s)")

    urls: list[str] = []
    seen: set[str] = set()

    def _absorb(html: str) -> int:
        added = 0
        s = BeautifulSoup(html, "lxml")
        for a in s.find_all("a", href=True):
            href = a["href"]
            mm = ARTICLE_RE.match(href)
            if mm and int(mm.group(1)) == year and int(mm.group(2)) == month and href not in seen:
                seen.add(href)
                urls.append(href)
                added += 1
        return added

    _absorb(first_html)
    # Walk pages 2..total_pages. Don't stop on the first empty page — a single
    # transient miss (Cloudflare cache, duplicate content) used to chop runs in
    # half. Only break after two consecutive empty pages, or a 404 (real end).
    consecutive_empty = 0
    for page in range(2, total_pages + 1):
        try:
            html = fetch_archive(browser, f"{base}page/{page}/")
        except FetchError:
            break  # 404 / Cloudflare hard fail — assume end of archive
        added = _absorb(html)
        if added == 0:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                break
        else:
            consecutive_empty = 0
        time.sleep(0.5)

    print(f"[{year}-{month:02d}] {len(urls)} unique article URLs")
    return urls


def main() -> int:
    import os

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("error: ANTHROPIC_API_KEY is required", file=sys.stderr)
        return 2

    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM (inclusive)")
    ap.add_argument("--end", default=None, help="YYYY-MM (inclusive). Defaults to current month.")
    ap.add_argument("--dry-run", action="store_true", help="Collect URLs but don't fetch/extract")
    ap.add_argument("--limit", type=int, default=None, help="Process at most N new articles (for testing)")
    args = ap.parse_args()

    start = _parse_yyyy_mm(args.start)
    end = _parse_yyyy_mm(args.end) if args.end else (date.today().year, date.today().month)

    store = Store()
    existing = store.existing_links()
    print(f"[store] {len(existing)} existing articles")

    with browser_session() as browser:
        all_urls: list[str] = []
        for y, m in _iter_months(start, end):
            all_urls.extend(collect_month_urls(browser, y, m))

        new_urls = [u for u in all_urls if u not in existing]
        print(f"[plan] {len(all_urls)} URLs found, {len(new_urls)} new (after dedupe)")

        if args.limit:
            new_urls = new_urls[: args.limit]
            print(f"[plan] limited to first {len(new_urls)} for testing")

        if args.dry_run or not new_urls:
            return 0

        batch: list[dict] = []
        failures: list[tuple[str, str]] = []
        t_start = time.time()
        for i, url in enumerate(new_urls, 1):
            elapsed = time.time() - t_start
            avg = elapsed / max(i - 1, 1)
            eta = avg * (len(new_urls) - i)
            print(f"[{i}/{len(new_urls)}] ({eta/60:.1f}m eta) {url}")
            try:
                html = fetch_article(browser, url)
                now_iso = datetime.now(timezone.utc).isoformat()
                article = llm_parse_article_html(html, url, now_iso)
                batch.append(article.as_record())
            except Exception as exc:  # noqa: BLE001
                print(f"  failed: {exc}", file=sys.stderr)
                failures.append((url, str(exc)))

            if len(batch) >= BATCH_SIZE:
                store.append_records(batch)
                print(f"[store] appended {len(batch)} records")
                batch.clear()
            time.sleep(1.5)

        if batch:
            store.append_records(batch)
            print(f"[store] appended {len(batch)} final records")

    cs = cache_stats()
    if cs["calls"]:
        cached_pct = 100 * cs["cache_read"] / max(1, cs["cache_read"] + cs["uncached_input"] + cs["cache_write"])
        print(f"[cache] {cs['calls']} calls | cache_read={cs['cache_read']} write={cs['cache_write']} "
              f"uncached_in={cs['uncached_input']} out={cs['output']} | {cached_pct:.0f}% of input served from cache")
    if failures:
        print(f"[done] {len(failures)} failed", file=sys.stderr)
        return 1
    print("[done]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
