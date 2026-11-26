# Mixtape setup (one time, ~20 minutes)

Mixtape has two parts:
- **The app** (`index.html`, `css/`, `js/`): a static site, hosted on GitHub Pages. No secrets in it.
- **The Worker** (`worker/mixtape-api.js`): a private Cloudflare Worker with a D1 database. It holds
  the music-service logins, keeps your library and syncs it every 15 minutes.

Never paste the app key or any token into a file, a chat, or a commit.

## 1. Make the Worker
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Start with Hello World!** →
   name it `mixtape-api` → **Deploy**.
2. Copy its address, like `https://mixtape-api.<your-subdomain>.workers.dev`.
3. **Edit code** → select everything in `worker.js`, delete it, paste the whole of
   `worker/mixtape-api.js` → **Deploy**.

## 2. Make the database
1. **Storage & databases** → **D1 SQL database** → **Create** → name `mixtape-data` → **Create**.
   (The Worker makes its own tables; you don't type any SQL.)
2. Worker `mixtape-api` → **Settings** → **Bindings** → **Add binding** → **D1 database** →
   variable name `DB`, database `mixtape-data` → **Add binding**.

## 3. Make the Spotify app
1. https://developer.spotify.com/dashboard → **Create app**.
   - Name `Mixtape`, any description.
   - **Redirect URIs**: add both
     - the live site, e.g. `https://ibrahim787898m.github.io/mixtape/` (exactly, with the final `/`)
     - `http://127.0.0.1:8000/` for testing on your computer (Spotify doesn't accept `localhost`)
   - APIs used: tick **Web API** and **Web Playback SDK**.
2. Save, then copy the **Client ID** (it isn't secret; you don't need the client secret).
3. Your account must have Premium (it does): Spotify requires it for apps in Development Mode.
   Development Mode allows 5 users, which is plenty for one person.

## 4. Give the Worker its settings
Worker → **Settings** → **Variables and Secrets** → **Add**:

| Type | Name | Value |
|---|---|---|
| Secret | `APP_KEY` | a long random string: run `python3 -c "import secrets; print(secrets.token_hex(32))"` and save it in your password manager |
| Text | `ALLOWED_ORIGINS` | `https://ibrahim787898m.github.io,http://127.0.0.1:8000` (no paths, comma-separated) |
| Text | `SPOTIFY_CLIENT_ID` | the Client ID from step 3 |

Then **Deploy**.

## 5. Turn on the 15-minute sync
Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add** → `*/15 * * * *` → **Add**.

## 6. Put the app online
1. Push this repo to GitHub as `mixtape` (public: there are no secrets in it).
2. Repo → **Settings** → **Pages** → Source: **Deploy from a branch** → `main` / root → Save.
3. After a minute the app is at `https://ibrahim787898m.github.io/mixtape/`.

## 7. Connect
1. Open the app → paste the Worker address and the app key → **Connect**.
2. **Connect Spotify** → sign in → you're sent back to Mixtape.
3. The first sync starts by itself (about a minute for a few thousand songs). After that it runs
   every 15 minutes, when you open the app, and with the sync button.
4. On your phone: open the same address, paste the Worker address + key once.

## Test on your computer (optional)
```
cd ~/code/mixtape && python3 -m http.server 8000 --bind 127.0.0.1
```
Open **http://127.0.0.1:8000/** (not `localhost`, so it matches the Spotify redirect URI).

## Troubleshooting
| Message | Fix |
|---|---|
| Can't reach the Worker | Wrong address, or the site isn't in `ALLOWED_ORIGINS` (exact origin, no path) |
| Wrong app key | Re-paste `APP_KEY` from your password manager |
| needs a D1 database bound as DB | Step 2 |
| Spotify: INVALID_CLIENT / redirect URI mismatch | The address in the browser must match a Redirect URI in step 3 exactly |
| Spotify sign-in expired | Spotify logins last 6 months: Settings → Spotify → **Sign in again** |
| A playlist shows no songs | You only follow it: Spotify shares songs only of playlists you own or collaborate on |

## Updating the Worker code
When `mixtape-api.js` changes: Worker → **Edit code** → replace everything → **Deploy**. Settings,
bindings and the database are kept.

## Free plan limits (plenty for one person)
Workers: 100,000 requests/day, ~10 ms CPU and 50 outgoing requests per run, which is why a sync
runs in small steps. D1: 5 GB, 100,000 rows written/day. Spotify Development Mode: 5 users.
