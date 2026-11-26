# CLAUDE.md — Mixtape

This is an **AI-built app** for the owner's daily use, not a learning repo. Claude writes and edits the code directly. This overrides the "hints, never solutions" rule in `~/code/CLAUDE.md`, but only for this repo. The owner runs git himself: suggest commit messages (imperative mood, "Docs:" prefix for docs-only changes), don't commit.

## What it is
One library for the owner's Spotify and YouTube Music songs. New songs added to playlists in either app are pulled in automatically, organised and filterable. The long-term goal is matching songs across both services and adding the missing ones to the other service.

## Layout
- `index.html`, `css/app.css`, `js/app.js` (UI, routing, filters, virtual list), `js/api.js` (Worker client), `js/spotify.js` (PKCE sign-in), `js/player.js` (playback: Web Playback SDK in desktop browsers, Spotify Connect remote control elsewhere; queue = the list you clicked in, sent in batches of 50 with the next batch loaded by Mixtape). Static, no build step. Hosted on GitHub Pages.
- `worker/mixtape-api.js`: the Cloudflare Worker (pasted into the dashboard, so it must stay **one file**). Setup and every manual step: `worker/SETUP.md`.
- `README.md` is the public description: update it when features change.

## Hard rules
- **The repo is public.** Never commit tokens, the app key, library exports or personal listening data. The Worker address + app key live in `localStorage['mixtape.api']` per device.
- Only the Worker holds music-service tokens (the Spotify refresh token in D1 `kv` 'sp.auth'). The browser never stores them; the PKCE code exchange happens in the browser and the refresh token goes straight to `/spotify/connect`.
- **Free-plan limits shape the Worker:** ~10 ms CPU and 50 outgoing requests per run. Keep sync work in small resumable steps (`SP_BUDGET` calls, cursor in `kv` 'sp.job'), trim Spotify responses with `fields`, write rows through one JSON parameter (`json_each`, D1 allows 100 bound parameters), and build big responses as JSON inside SQLite (`jsonRows`, slices under D1's 2 MB value limit). Don't `JSON.parse`/`stringify` large payloads in the Worker.
- **Never delete the owner's data in a music service.** Writing to Spotify/YouTube (later steps) only ever adds; removals stay manual.
- Spotify API state as of Nov 2026 (Feb 2026 Development Mode changes): playlist tracks are `/playlists/{id}/items` and the field is `item` (fallback `track`); items only for playlists the user owns or collaborates on; `/me/tracks` max 50 per page; no batch `GET /tracks`; search max 10 results; owner needs Premium; 5 users; refresh tokens last 6 months and may rotate (always store a returned one); redirect URIs must be https or `http://127.0.0.1:PORT` (no `localhost`).
- YouTube (Data API v3, scope `auth/youtube`): Google sign-in is the web-server flow done by the Worker (`/youtube/start` → Google → `/youtube/callback`, which has no app key and is protected by a one-time `yt.state.*`); the client secret lives only in the Worker. Liked Music = the likes playlist (`yt.me.likes`, usually `LL`) filtered to category 10; other likes go to the `skip` table. Playlists re-read when their item count changes, and once a day. Album/year come from the "Provided to YouTube by …" description of Topic tracks. Quota 10,000/day; insert costs 50 (later steps).
- Services take turns in a sync (`sync.cur`): Spotify's cycle, then YouTube's.
- Icons: inline SVG through `I('name')` (the `ICONS` map in `js/app.js`).

## Data model (D1)
`kv` (logins, sync cursor, lock) · `playlists` (id `sp:<id>` / `sp:liked`, snapshot `snap` vs last read `synced`, `readable` = Spotify returned its items (decided by asking, never by comparing owner ids with `/me`: they don't match for every account), `gone`) · `tracks` (id `sp:<trackId>`, ISRC for matching later) · `items` (pl, pos, track, added; liked songs use pos = save time ×10 so new likes never shift old rows) · `skip` (liked videos that aren't music) · `log`. Ids: `sp:…` Spotify, `yt:…` YouTube.

## Testing (no Node here)
- Worker: run the Worker file in headless Chrome against **real SQLite** through a small local Python server that executes the D1 statements, with Spotify faked in the page (paging, followed playlists, local files/episodes, edits, un-likes, 429, `invalid_grant`, two syncs at once).
- App: serve a copy with `python3 -m http.server` (ES modules don't load from `file://`), fake the Worker in the page, check every view, then screenshots at desktop size and 390×844, dark and light.
