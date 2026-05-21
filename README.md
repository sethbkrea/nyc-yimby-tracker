# nyc-yimby-tracker

Scrapes [newyorkyimby.com](https://newyorkyimby.com/) and stores every article as a record in a single file: [`articles.json`](articles.json). That file lives in this repo and is updated by GitHub Actions after each scrape.

Each record has:

| Field | Source |
| --- | --- |
| `url` | RSS feed link / archive page link |
| `address` | parsed from article title / first body sentence |
| `developer` | parsed from body ("X is listed as the owner/applicant") |
| `neighborhood` | parsed from title; URL slug fallback |
| `borough` | parsed from title; URL slug fallback (Manhattan / Brooklyn / Queens / Staten Island / The Bronx) |
| `notes` | floors, height, square footage, unit count, architect — extracted via regex |
| `body` | full body text from `.entry-content` |
| `scraped_at` | UTC timestamp when the record was written |

## How it runs

- **Daily** — `.github/workflows/daily-scrape.yml` runs `python scrape.py` once a day. It pulls the RSS.app feed, fetches new articles through headless Chromium (Playwright, to clear Cloudflare), appends them to `articles.json`, and commits the file back to the repo.
- **Backfill** — `.github/workflows/backfill.yml` runs `python backfill.py` on demand with `start_month` / `end_month` inputs. Crawls month-archive pages, dedupes against `articles.json`, fetches missing articles in batches of 25. Use it once to backfill August 2025 → today.
- **Web UI** — A Next.js dashboard in [`web/`](web/), deployable to Vercel, lets you trigger either workflow with one click and view recent articles. See [`web/README.md`](web/README.md).

## One-time setup

### 1. GitHub Actions secrets

In the repo: Settings → Secrets and variables → Actions → New repository secret. Add one:

| Secret | Value |
| --- | --- |
| `YIMBY_FEED_URL` | `https://rss.app/feeds/ArDtOYRExEskqNMj.xml` |

That's it. `articles.json` lives in the repo and is updated via the workflow's built-in `GITHUB_TOKEN` (no extra credentials needed).

### 2. (Optional) Repo variables

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_AGE_DAYS` | `30` | Daily scrape skips feed items older than this. |

### 3. Run it once by hand

Actions → "Daily YIMBY scrape" → Run workflow. After it completes, look at the commit log — you'll see a `chore: daily scrape` commit with the updated `articles.json`.

## Running locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium

export YIMBY_FEED_URL='https://rss.app/feeds/ArDtOYRExEskqNMj.xml'
python scrape.py                              # daily-style run
python backfill.py --start 2025-08 --dry-run  # see what backfill would do
python backfill.py --start 2025-08            # real backfill
```

`articles.json` will be created/updated in the working directory.

## Files

```
scrape.py     daily entrypoint — RSS-driven, dedupe, polite delays
backfill.py   historical crawler over /YYYY/MM/ archive pages
feed.py       parse the RSS.app feed → (url, pub_datetime) items
article.py    Playwright wrapper — fresh context per page to clear Cloudflare
extract.py    regex-based parsing of address / developer / location / notes
store.py      read/append articles.json
articles.json the database — committed and updated by GitHub Actions
web/          Next.js dashboard for Vercel
.github/workflows/daily-scrape.yml   daily cron + manual trigger
.github/workflows/backfill.yml       manual historical backfill
```

## Notes & limitations

- **One Playwright context per page.** Cloudflare returns a stricter JS challenge on follow-up navigations in the same browser session. Opening a fresh context for every page costs ~5-10s of CF clearance time but is reliable.
- **GitHub Actions 6h cap.** A full backfill from Aug 2025 → today is well under that. If you ever need multi-year backfills, split the date range across two dispatches.
- **Best-effort extraction.** The `developer` and `notes` fields are regex-based on YIMBY's writing patterns. Articles that deviate (e.g. a permit-status update with no project specs) will have empty fields; the full `body` text is always stored so nothing is lost.
