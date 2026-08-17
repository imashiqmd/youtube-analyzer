# Deploy: GitHub Pages + Render + Neon

## Architecture

| Layer | Service | URL |
|-------|---------|-----|
| Frontend | GitHub Pages | `https://imashiqmd.github.io/youtube-analyzer/` |
| API | Render (free) | `https://youtube-analyzer-api.onrender.com` |
| Database | Neon Postgres | connection string in Render env |

## 1. Neon (database)

You likely already have this. In the [Neon console](https://console.neon.tech):

1. Copy the **pooled** connection string (`postgres://...?sslmode=require`).
2. Keep it for Render — do not commit it to git.

Tables are created automatically when the API starts (`npm run db:migrate` runs on boot).

## 2. Render (backend API)

1. Go to [render.com](https://render.com) → **New** → **Blueprint**.
2. Connect the `imashiqmd/youtube-analyzer` GitHub repo.
3. Render reads `render.yaml` and creates `youtube-analyzer-api`.
4. Set these environment variables in the Render dashboard:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Neon pooled connection string |
| `YOUTUBE_API_KEY` | Your YouTube Data API v3 key |
| `ADMIN_EMAIL` | Email that gets admin access |

5. Deploy and wait until **Live**. Note the service URL, e.g. `https://youtube-analyzer-api.onrender.com`.
6. Test: `curl https://youtube-analyzer-api.onrender.com/health` → `{"ok":true}`

**Note:** Render free tier sleeps after ~15 min idle. The first request after sleep can take 30–60s (cold start).

## 3. GitHub (frontend)

### Secrets

In GitHub → **Settings** → **Secrets and variables** → **Actions**, add:

| Secret | Value |
|--------|-------|
| `GEMINI_API_KEY` | Already set ✓ |
| `API_BASE_URL` | Your Render URL, e.g. `https://youtube-analyzer-api.onrender.com` |

### Pages

1. GitHub → **Settings** → **Pages** → Source: **GitHub Actions**.
2. Push to `main` — the workflow deploys `index.html` and `admin.html` with API keys injected.

Live site: **https://imashiqmd.github.io/youtube-analyzer/**

Admin panel: **https://imashiqmd.github.io/youtube-analyzer/admin.html**

## 4. After deploy checklist

- [ ] `GET /health` returns ok on Render
- [ ] Main app loads and shows sign-in (not “Sign-in is not available”)
- [ ] Sign up / sign in works
- [ ] Analyze a channel works
- [ ] Save channel → sign out → sign in → saved channel appears
- [ ] Admin panel works when signed in as `ADMIN_EMAIL`

## Local development

```bash
# Terminal 1 — API
cd backend && cp .env.example .env   # fill in Neon + YouTube key
npm install && npm start

# Terminal 2 — frontend
python3 -m http.server 8080
# open http://localhost:8080
```
