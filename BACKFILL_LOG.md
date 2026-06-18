# Historical backfill log

Tracks which YIMBY archive ranges have been backfilled into `articles.json`, so
runs are resumable and we never re-pay for a range already done. `backfill_batch.py`
also skips any URL already in `articles.json`, so re-running a covered range is a
no-op (but wastes crawl time).

Run command (Batch API, 50% off; set the key in `.env` first):
```bash
cd "/Users/sethsamowitz/YIMBY Scraper"
set -a; . ./.env; set +a
.venv/bin/python backfill_batch.py --start <YYYY-MM> --end <YYYY-MM> --chunk 300
```

## Completed

| Date run | Range | Articles added | Notes |
|----------|-------|----------------|-------|
| 2026-06-18 | **2024-01 → 2024-07** | **700** | Batch API; 3 chunks of 300/300/100, all succeeded. All have publish dates + article_type + units. `cache_read=0` (Haiku prefix < 2048 min → caching no-op); batch still billed at 50% (~$0.002/article ≈ ~$1.5). Batch IDs: `msgbatch_01JnNxubFPdyoSw7ZECWTj6U`, `msgbatch_01XyDg1qeoeskGvG7y3PXYhA`, `msgbatch_01JiC7eUqufbVZcJtXSU7vTs`. |
| (prior) | 2025-08 → 2026-06 | ~1,265 | Original RSS scrape + daily-scrape automation. |

**Corpus now: ~1,969 articles, span 2024-01 → 2026-06.**

## Remaining (toward the 2017 goal)

| Range | Est. articles | Est. cost (batch) | Status |
|-------|---------------|-------------------|--------|
| 2017-01 → 2023-12 | ~9,000 | ~$18 | not started |
| 2013-01 → 2016-12 | ~4,000 | ~$8 | optional |

Next command:
```bash
.venv/bin/python backfill_batch.py --start 2017-01 --end 2023-12 --chunk 300
```
