# YIMBY Tracker — web UI

A Next.js dashboard, deployable to Vercel, that drives the scraper in this repo. Vercel can't run Playwright, so this UI is a control plane: it triggers GitHub Actions workflows in `sethbkrea/nyc-yimby-tracker` and reads `articles.json` from the repo for a preview.

## What you get

- **Sign in with Google** — only emails in `ALLOWED_EMAILS` can use the app.
- **Run daily scrape** — dispatches `.github/workflows/daily-scrape.yml`.
- **Run backfill** — dispatches `.github/workflows/backfill.yml` with `start_month` / `end_month` / `dry_run` inputs.
- **Recent runs panel** — polls the GitHub Actions API every 10 s, links to logs.
- **Articles** — most recent 50 records from `articles.json`, with total count.

## Deploy to Vercel

### 1. Create the Google OAuth client

1. <https://console.cloud.google.com/apis/credentials> → **Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URI: `https://<your-vercel-domain>.vercel.app/api/auth/callback/google`. For the first deploy you can guess and add it later.
4. Save → copy the **Client ID** and **Client secret**.

### 2. Create a GitHub Personal Access Token

Fine-grained, scoped to `sethbkrea/nyc-yimby-tracker`:

- **Repository access:** only `nyc-yimby-tracker`.
- **Permissions:** Actions = Read and write, Contents = Read-only, Metadata = Read-only.

Save the token. You'll paste it as `GH_TOKEN` below.

### 3. Import the repo to Vercel

1. <https://vercel.com/new> → Import `sethbkrea/nyc-yimby-tracker`.
2. **Root directory:** `web`.
3. Framework preset: Next.js (auto-detected).
4. Add the environment variables below.
5. Deploy.

### 4. Environment variables

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | Run `openssl rand -base64 32` and paste the output. |
| `AUTH_GOOGLE_ID` | From step 1. |
| `AUTH_GOOGLE_SECRET` | From step 1. |
| `ALLOWED_EMAILS` | Comma-separated allow-list of Google account emails. Must include your own. |
| `GITHUB_OWNER` | `sethbkrea` |
| `GITHUB_REPO` | `nyc-yimby-tracker` |
| `GH_TOKEN` | The PAT from step 2 (used for both dispatching workflows and fetching `articles.json`). |

That's the full list — **no service-account JSON, no Sheet ID**. The data lives in the repo.

### 5. Wire the redirect URI back

Once Vercel gives you the live URL, edit the Google OAuth client and set the authorized redirect URI to `https://<that-url>/api/auth/callback/google`.

## Local development

```bash
cd web
cp .env.example .env.local        # fill in real values
npm install
npm run dev
# open http://localhost:3000
```

For local OAuth, add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI in the Google OAuth client.

## Notes

- Articles are fetched via the GitHub Contents API (`Accept: application/vnd.github.raw`), so the same `GH_TOKEN` works whether the repo is public or private.
- The dispatch endpoint allow-lists exactly two workflow files. Anything else returns 400 — even with a valid session, you can't trigger arbitrary workflows.
- The list endpoint strips the long `body` field for the preview table; the full body is in the JSON file in the repo if you need it.
