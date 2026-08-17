# Backend API for YouTube Channel Analyzer

Caches YouTube channel data in Postgres so repeat requests within 24 hours skip the YouTube Data API.

## Setup

### Option A — Cursor / VS Code (recommended)

1. Install **Docker Desktop** and **Node.js** once (if not already):
   - Docker: https://www.docker.com/products/docker-desktop/
   - Node: `brew install node` or https://nodejs.org

2. In Cursor, press **`Cmd+Shift+P`** → type **Run Task** → choose:
   - **`Backend: Check Prerequisites`** — verify Docker & Node are installed
   - **`Backend: Full Setup`** — starts Postgres, installs deps, creates tables
   - **`Backend: Start API`** — runs the server on port 3001
   - **`Backend: Test /analyze`** — test curl request

### Option B — Terminal

```bash
cd backend
cp .env.example .env
# Edit .env with your YOUTUBE_API_KEY and DATABASE_URL

# Start Postgres (optional Docker)
docker compose up -d

npm install
npm run db:migrate
npm run dev
```

## API

### `POST /analyze`

Request:

```json
{ "handle": "@mkbhd" }
```

Also accepts channel URLs and `UC...` channel IDs.

Response:

```json
{
  "source": "cache",
  "units_used": 0,
  "channelId": "UC...",
  "lastSyncedAt": "2026-08-17T06:00:00.000Z",
  "channel": { "id": "...", "title": "...", "uploadsPlaylistId": "..." },
  "videoIds": ["..."],
  "rawVideos": [{ "id": "...", "snippet": {}, "statistics": {} }]
}
```

- `source`: `"cache"` when data is fresh (< 24h), `"api"` when fetched from YouTube
- `units_used`: quota units consumed for this request (0 on cache hit)

### `GET /health`

Database connectivity check.

## YouTube fetch flow

Never uses `search.list`. On cache miss or stale data:

1. `channels.list` (by id / forHandle / forUsername)
2. `playlistItems.list` (paginated, 50 per page)
3. `videos.list` (batched, 50 IDs per call)

Each API call costs **1 quota unit** and is logged to `quota_logs`.

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default `3001`) |
| `DATABASE_URL` | Postgres connection string |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (server-side only) |
