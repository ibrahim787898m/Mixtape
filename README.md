# Mixtape

All my songs from **Spotify** and **YouTube Music** in one place. Whenever I add a song to a playlist (or like it) in either app, Mixtape pulls it into one organised library with search, filters and sorting.

I listen on both apps, and keeping them in sync by hand (or with a separate sync tool) was annoying. Mixtape is the one place that knows about everything.

## Features
- **One library**: every song from your playlists and liked songs, with cover art, artist, album, year and length
- **Your playlists**: each with its own page, in playlist order or sorted by any column
- **Search and filters**: instant search across title, artist and album; filter by service, date added, decade and playlist; sort by title, album, date added or length
- **Both services**: Spotify playlists and liked songs, YouTube Music playlists (yours or anyone's public ones), side by side with a badge on every song
- **Auto-sync**: a private Cloudflare Worker checks Spotify and YouTube Music every 15 minutes, and again when you open the app. Only playlists that changed are re-read.
- **Play inside the app**: click any song and the list you're looking at becomes the queue. On a computer Mixtape is a Spotify player itself (Web Playback SDK, Premium). On a phone it remote-controls the Spotify app (Spotify Connect). YouTube Music songs play in YouTube's embedded player, in a small video window. Mixed lists play straight through, switching services between songs. Player bar with seek, volume, media keys and the space bar.
- **One song, both services**: a song you have on Spotify and YouTube Music shows once with both badges and plays from Spotify (audio only). Matching uses cleaned-up titles ("(Official Video)", "feat.", "- Remastered", "| Film | Singer" removed), artist and length, and works in any script. Filter by "on both", "only on Spotify" or "only on YouTube".
- **Mixtape Connect**: one "now playing" shared by every device, like Spotify Connect. Any open Mixtape (laptop, phone) shows the same song and position and can control it. The **Playing on** picker moves playback between your Mixtape devices and your Spotify devices (phone app, TV), continuing from the same spot.
- **Fast with big libraries**: only the rows on screen are drawn, so 10,000 songs scroll smoothly
- **Dark and light themes**, works on desktop and phone

## Roadmap
1. ✅ Spotify sign-in, playlists and liked songs, library view
   ✅ Playback (Spotify in the browser, or your Spotify app on a phone)
2. ✅ YouTube Music import (playlists added by link, read with an API key: no Google sign-in needed)
3. ✅ Matching the same song across both services (shown once, played from Spotify)
4. Smart playlists (saved filters, like "missing on YouTube Music")
5. Add missing songs to the other service in one click
6. ✅ Play YouTube Music songs inside the app too (YouTube's embedded player)

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
Vanilla JS (ES modules) · CSS custom properties · Cloudflare Workers + D1 + Cron Triggers · Spotify Web API + Web Playback SDK · YouTube Data API v3
