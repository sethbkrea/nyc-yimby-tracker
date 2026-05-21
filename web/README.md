# YIMBY Tracker — web UI

A Next.js dashboard, deployable to Vercel, that drives the scraper in this repo. Vercel can't run Playwright, so this UI is a control plane: it triggers GitHub Actions workflows in `sethbkrea/nyc-yimby-tracker` and reads `articles.json` from the repo for a preview.

## What you get

- **Run daily scrape** — dispatches `.github/workflows/daily-scrape.yml`.
- **Run backfill** — dispatches `.github/workflows/backfill.yml` with `start_month` / `end_month` / `dry_run` inputs.
- **Recent runs panel** — polls the GitHub Actions API every 10 s, links to logs.
- **Articles** — most recent 50 records from `articles.json`, with total count.

No in-app login. Gating happens at the **Vercel deployment** level (Pro feature) — see the security note below.

## Deploy to Vercel

### 1. Create a GitHub Personal Access Token

Fine-grained, scoped to `sethbkrea/nyc-yimby-tracker`:

- **Repository access:** only `nyc-yimby-tracker`.
- **Permissions:** Actions = Read and write, Contents = Read-only, Metadata = Read-only.

Save the token. You'll paste it as `GH_TOKEN` below.

### 2. Import the repo to Vercel

1. <https://vercel.com/new> → Import `sethbkrea/nyc-yimby-tracker`.
2. **Root directory:** `web`.
3. Framework preset: Next.js (auto-detected).
4. Add the environment variables below.
5. Deploy.

### 3. Environment variables

| Variable | Value |
| --- | --- |
| `GITHUB_OWNER` | `sethbkrea` |
| `GITHUB_REPO` | `nyc-yimby-tracker` |
| `GH_TOKEN` | The PAT from step 1 (used for both dispatching workflows and fetching `articles.json`). |

That's the entire list.

### 4. Enable Vercel password protection (important)

The app itself has no login. Without password protection, anyone who finds the URL can trigger workflows (and burn your Actions minutes).

1. In the Vercel project → Settings → **Deployment Protection** → **Password Protection**.
2. Pick a password. Save.
3. From now on every visitor — including for `/api/dispatch` — has to enter the password before any route loads.

(Password Protection is a Vercel Pro feature.)

## Local development

```bash
cd web
cp .env.example .env.local        # fill in GH_TOKEN
npm install
npm run dev
# open http://localhost:3000
```

Local has no password gate. If you don't want random processes on your machine able to POST to localhost:3000/api/dispatch, just don't expose the dev port.

## Notes

- Articles are fetched via the GitHub Contents API (`Accept: application/vnd.github.raw`), so the same `GH_TOKEN` works whether the repo is public or private.
- The dispatch endpoint allow-lists exactly two workflow files. Anything else returns 400 — useful belt-and-suspenders, but the real gate is Vercel's password protection.
- The list endpoint strips the long `body` field for the preview table; the full body is in `articles.json` in the repo if you need it.
