#!/bin/bash
# Self-resuming historical backfill, managed by a macOS LaunchAgent.
#
# Runs backfill_batch.py for the target range. If it's interrupted (laptop
# sleep drops the network mid-chunk), the LaunchAgent relaunches this script
# and the backfill picks up where it left off — already-saved URLs are skipped.
# After each pass it commits + pushes articles.json so progress is live on the
# site. When a fresh crawl finds 0 new articles, the range is complete: it
# writes a DONE marker and exits 0 so the LaunchAgent stops relaunching it.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "/Users/sethsamowitz/YIMBY Scraper" || exit 1

START="2017-01"
END="2023-12"
LOG="backfill_loop.log"
DONE_MARKER=".backfill_2017_2023.done"

# Already finished on a previous launch? Do nothing and exit cleanly.
[ -f "$DONE_MARKER" ] && { echo "$(date) already done; nothing to do" >> "$LOG"; exit 0; }

set -a; . ./.env; set +a

echo "==== $(date) backfill pass start ($START -> $END) ====" >> "$LOG"
OUT=$(.venv/bin/python backfill_batch.py --start "$START" --end "$END" --chunk 300 2>&1)
echo "$OUT" >> "$LOG"

# Commit + push whatever got added this pass (push failures are non-fatal —
# data is safe locally and will go up on the next successful pass).
/usr/bin/git add articles.json BACKFILL_LOG.md 2>/dev/null
if ! /usr/bin/git diff --cached --quiet 2>/dev/null; then
  /usr/bin/git commit -m "chore: backfill 2017-2023 progress [skip ci]" >> "$LOG" 2>&1
  gh auth switch --hostname github.com --user sethbkrea >/dev/null 2>&1
  /usr/bin/git pull --rebase origin main >> "$LOG" 2>&1
  /usr/bin/git push origin main >> "$LOG" 2>&1
fi

# A clean pass that finds nothing new means the range is fully backfilled.
if echo "$OUT" | grep -q "\[plan\] 0 new articles in range"; then
  date > "$DONE_MARKER"
  echo "==== $(date) ALL DONE — range complete ====" >> "$LOG"
  exit 0
fi

# Not done yet (more chunks remain, or the pass was interrupted). Exit non-zero
# so the LaunchAgent relaunches us to continue.
echo "==== $(date) pass ended, more work remains — will relaunch ====" >> "$LOG"
exit 1
