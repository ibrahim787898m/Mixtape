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
     - the live site, e.g. `https://ibrahim787898m.github.io/Mixtape/` (exactly, with the final `/`)
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
1. Push this repo to GitHub as `Mixtape` (public: there are no secrets in it).
2. Repo → **Settings** → **Pages** → Source: **Deploy from a branch** → `main` / root → Save.
3. After a minute the app is at `https://ibrahim787898m.github.io/Mixtape/`.

## 7. Connect
1. Open the app → paste the Worker address and the app key → **Connect**.
2. **Connect Spotify** → sign in → you're sent back to Mixtape.
3. The first sync starts by itself (about a minute for a few thousand songs). After that it runs
   every 15 minutes, when you open the app, and with the sync button.
4. On your phone: open the same address, paste the Worker address + key once.

## 8. YouTube Music (Google sign-in)
YouTube Music playlists are YouTube playlists, read through the official YouTube Data API.
1. https://console.cloud.google.com → project picker at the top → **New project** → name `Mixtape` → **Create**,
   and make sure it's selected.
2. **APIs & Services** → **Library** → search **YouTube Data API v3** → **Enable**.
3. **Google Auth Platform** (or "OAuth consent screen") → **Get started**:
   - App name `Mixtape`, your email as support email → **Next**
   - Audience: **External** → **Next** → contact email → agree → **Create**.
4. Still in Google Auth Platform:
   - **Data Access** → **Add or remove scopes** → tick `.../auth/youtube` ("Manage your YouTube account";
     Mixtape reads now and will only ever *add* songs later) → **Update** → **Save**.
   - **Audience** → **Publish app** → confirm. It says "In production". **Don't** submit for verification.
     This matters: while an app is in "Testing", Google signs you out every 7 days.
5. **Clients** → **Create client** → type **Web application** → name `Mixtape Worker` →
   **Authorized redirect URIs** → **Add URI** → your Worker address + `/youtube/callback`, e.g.
   `https://mixtape-api.<your-subdomain>.workers.dev/youtube/callback` → **Create**.
   Copy the **Client ID** and **Client secret** (the secret is shown once; keep it in your password manager).
6. Worker → **Settings** → **Variables and Secrets** → add:

   | Type | Name | Value |
   |---|---|---|
   | Text | `GOOGLE_CLIENT_ID` | the Client ID |
   | Secret | `GOOGLE_CLIENT_SECRET` | the Client secret |

7. Paste the newest `mixtape-api.js` into the Worker (**Edit code** → replace everything → **Deploy**).
8. Mixtape → **Settings** → **Connect YouTube Music** → pick the account (or channel) you use for YouTube Music.
   Google shows **"Google hasn't verified this app"**: that's expected for your own personal app →
   **Advanced** → **Go to Mixtape (unsafe)** → tick the YouTube permission → **Continue**. You land back in Mixtape.

What syncs: your own YouTube Music playlists, and **Liked Music** = your liked videos that are music
(other liked videos are left out). Uses about 2 of YouTube's 10,000 free daily quota units per sync when nothing changed.

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
| Google: redirect_uri_mismatch | The Authorized redirect URI (step 8.5) must be exactly the Worker address + `/youtube/callback` |
| Google: access_denied / "app is blocked" | Step 8.4: the app must be published ("In production") or your account added as a test user |
| no refresh token | Google only sends one on the first sign-in: myaccount.google.com → Security → Third-party connections → Mixtape → remove access, then connect again |
| This Google account has no YouTube channel | Choose the channel you use for YouTube Music on the account picker (brand channels are listed there) |
| YouTube daily quota used up | Syncing continues after midnight Pacific time |

## Updating the Worker code
When `mixtape-api.js` changes: Worker → **Edit code** → replace everything → **Deploy**. Settings,
bindings and the database are kept.

## Free plan limits (plenty for one person)
YouTube Data API: 10,000 units/day (reading costs 1 unit per 50 songs). Workers: 100,000 requests/day, ~10 ms CPU and 50 outgoing requests per run, which is why a sync
runs in small steps. D1: 5 GB, 100,000 rows written/day. Spotify Development Mode: 5 users.
