"""One-off historical backfill. Crawls /YYYY/MM/page/N/ archives and writes any
missing articles to articles.json.

Usage:
  python backfill.py --start 2025-08
  python backfill.py --start 2025-08 --end 2026-05

Safe to interrupt: each batch is written to disk immediately, and re-running
skips URLs already present.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import date

from bs4 import BeautifulSoup

from article import FetchError, browser_session, fetch_archive, fetch_article
from extract import parse_article
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
    """Return all in-month article URLs for /YYYY/MM/."""
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
            m = ARTICLE_RE.match(href)
            if m and int(m.group(1)) == year and int(m.group(2)) == month and href not in seen:
                seen.add(href)
                urls.append(href)
                added += 1
        return added

    _absorb(first_html)
    for page in range(2, total_pages + 1):
        try:
            html = fetch_archive(browser, f"{base}page/{page}/")
        except FetchError:
            break
        added = _absorb(html)
        if added == 0:
            break
        time.sleep(0.5)

    print(f"[{year}-{month:02d}] {len(urls)} unique article URLs")
    return urls


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM (inclusive)")
    ap.add_argument("--end", default=None, help="YYYY-MM (inclusive). Defaults to current month.")
    ap.add_argument("--dry-run", action="store_true", help="Collect URLs but don't fetch/write articles")
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

        if args.dry_run or not new_urls:
            return 0

        batch = []
        failures: list[tuple[str, str]] = []
        t_start = time.time()
        for i, url in enumerate(new_urls, 1):
            elapsed = time.time() - t_start
            avg = elapsed / max(i - 1, 1)
            eta = avg * (len(new_urls) - i)
            print(f"[{i}/{len(new_urls)}] ({eta/60:.1f}m eta) {url}")
            try:
                html = fetch_article(browser, url)
                batch.append(parse_article(html, url))
            except Exception as exc:  # noqa: BLE001
                print(f"  failed: {exc}", file=sys.stderr)
                failures.append((url, str(exc)))

            if len(batch) >= BATCH_SIZE:
                store.append(batch)
                print(f"[store] appended {len(batch)} records")
                batch.clear()
            time.sleep(1.5)

        if batch:
            store.append(batch)
            print(f"[store] appended {len(batch)} final records")

    if failures:
        print(f"[done] {len(failures)} failed", file=sys.stderr)
        return 1
    print("[done]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
