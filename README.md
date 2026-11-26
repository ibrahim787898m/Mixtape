# Mixtape

All my songs from **Spotify** and **YouTube Music** in one place. Whenever I add a song to a playlist (or like it) in either app, Mixtape pulls it into one organised library with search, filters and sorting.

I listen on both apps, and keeping them in sync by hand (or with a separate sync tool) was annoying. Mixtape is the one place that knows about everything.

## Features
- **One library**: every song from your playlists and liked songs, with cover art, artist, album, year and length
- **Your playlists**: each with its own page, in playlist order or sorted by any column
- **Search and filters**: instant search across title, artist and album; filter by service, date added, decade and playlist; sort by title, album, date added or length
- **Auto-sync**: a private Cloudflare Worker checks Spotify every 15 minutes, and again when you open the app. Only playlists that changed are re-read.
- **Fast with big libraries**: only the rows on screen are drawn, so 10,000 songs scroll smoothly
- **Dark and light themes**, works on desktop and phone

## Roadmap
1. ✅ Spotify sign-in, playlists and liked songs, library view
2. YouTube Music sign-in and import
3. Matching the same song across both services
4. Smart playlists (saved filters, like "missing on YouTube Music")
5. Add missing songs to the other service in one click
6. Play inside the app (Spotify Web Playback SDK, YouTube player)

## How it works
```
Spotify ─┐                    ┌─ D1 database (library, logins)
         ├─► Cloudflare Worker ┤
YouTube ─┘   (cron every 15 min) └─► GET /library ─► Mixtape (this static site)
```
- The app is plain HTML, CSS and JavaScript modules, with no build step.
- Spotify sign-in uses PKCE in the browser. The refresh token goes to the Worker, which does the syncing. No client secret anywhere.
- The Worker only answers requests carrying the app key, which lives in each device's browser storage and never in this repo.

Setup: [`worker/SETUP.md`](worker/SETUP.md).

## Tech
Vanilla JS (ES modules) · CSS custom properties · Cloudflare Workers + D1 + Cron Triggers · Spotify Web API
