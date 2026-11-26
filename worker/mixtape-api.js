/* Mixtape API — Cloudflare Worker (paste this whole file into the Worker editor).

   Mixtape (the web app) keeps one library of the songs in your Spotify and YouTube Music
   playlists. This Worker holds the music-service logins, keeps the library in a D1 database,
   and syncs it every 15 minutes (cron trigger) and when the app asks.

     GET  /status                 → connected services, library counts, sync progress, recent log
     GET  /config                 → the Spotify client id (public), so the app needs no code edits
     POST /spotify/connect        {refresh_token}  → store a Spotify login (from the app's PKCE sign-in)
     POST /spotify/disconnect     → forget the Spotify login (the library stays)
     GET  /spotify/token          → a fresh Spotify access token (for playback in the app)
     POST /youtube/start          {return}  → a Google sign-in address (the app opens it)
     GET  /youtube/callback       ← Google sends you back here; the Worker keeps the login, then returns you to the app
     POST /youtube/disconnect     → forget the YouTube login (the library stays)
     POST /sync                   → run one sync step; call again while {done:false}
     GET  /library                → the whole library (playlists, tracks, playlist items)

   Settings (Worker → Settings → Variables and Secrets):
     Secret:  APP_KEY            a long random string; the same one goes into Mixtape → Settings
     Text:    ALLOWED_ORIGINS    e.g. https://mixtape.example.com,http://127.0.0.1:8000
              SPOTIFY_CLIENT_ID  from developer.spotify.com (not secret)
              GOOGLE_CLIENT_ID   from Google Cloud → Credentials (not secret)
     Secret:  GOOGLE_CLIENT_SECRET  the matching client secret (only here, never in the app)
     Binding: DB                 a D1 database
     Trigger: cron  0,15,30,45 * * * *   (Settings → Triggers → Cron)

   Free-plan limits shape the code: ~10 ms CPU and 50 outgoing requests per run. So a sync is
   split into small steps (at most SP_BUDGET Spotify calls each) with a saved cursor, each page
   is trimmed with Spotify's `fields` filter, writes go to D1 as one JSON parameter
   (json_each), and /library is built as JSON inside SQLite, never re-encoded here.
*/

const SP_API = 'https://api.spotify.com/v1/';
const SP_BUDGET = 12;            // Spotify calls per sync step (the free plan allows 50 requests a run)
const LOCK_MS = 55e3;            // one sync step at a time (cron and the app can overlap)
const LOG_KEEP = 60;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ---------- database ---------- */
let ready = false;
async function db(env) {
  if (!env.DB) throw new HttpError(500, 'The Worker needs a D1 database bound as DB (see SETUP.md)');
  if (!ready) {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, src TEXT, ext TEXT, name TEXT, image TEXT,
        snap TEXT, synced TEXT, total INTEGER, owner TEXT, kind TEXT, readable INTEGER, gone INTEGER DEFAULT 0, updated INTEGER)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, src TEXT, ext TEXT, title TEXT, artists TEXT,
        album TEXT, image TEXT, dur INTEGER, isrc TEXT, year TEXT, url TEXT, updated INTEGER)`),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS items (pl TEXT, pos INTEGER, track TEXT, added TEXT, PRIMARY KEY (pl, pos))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, msg TEXT)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS skip (pl TEXT, pos INTEGER, track TEXT, added TEXT, PRIMARY KEY (pl, pos))'),   // liked videos that aren't music
    ]);
    ready = true;
  }
  return env.DB;
}
const kvGet = async (d, k) => { const r = await d.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? JSON.parse(r.v) : null; };
const kvSet = (d, k, v) => d.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v));
const kvDel = (d, k) => d.prepare('DELETE FROM kv WHERE k = ?').bind(k);
const logStmt = (d, msg) => d.prepare('INSERT INTO log (at, msg) VALUES (?, ?)').bind(Date.now(), msg);

// many rows in one statement: the rows travel as one JSON parameter (D1 allows 100 parameters)
const upsertTracks = (d, rows) => d.prepare(`INSERT INTO tracks (id, src, ext, title, artists, album, image, dur, isrc, year, url, updated)
  SELECT j->>'id', j->>'src', j->>'ext', j->>'title', j->>'artists', j->>'album', j->>'image', j->>'dur', j->>'isrc', j->>'year', j->>'url', ?
  FROM (SELECT value AS j FROM json_each(?)) WHERE true
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, artists = excluded.artists, album = excluded.album, image = excluded.image,
    dur = excluded.dur, isrc = COALESCE(excluded.isrc, tracks.isrc), year = excluded.year, url = excluded.url, updated = excluded.updated`)
  .bind(Date.now(), JSON.stringify(rows));
const putItems = (d, rows) => d.prepare(`INSERT OR REPLACE INTO items (pl, pos, track, added)
  SELECT j->>'pl', j->>'pos', j->>'track', j->>'added' FROM (SELECT value AS j FROM json_each(?))`).bind(JSON.stringify(rows));

/* ---------- Spotify ---------- */
async function spToken(env, d) {
  const acc = await kvGet(d, 'sp.auth');
  if (!acc) throw new HttpError(409, 'Spotify is not connected');
  if (acc.access && acc.exp > Date.now() + 60e3) return acc.access;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acc.refresh, client_id: env.SPOTIFY_CLIENT_ID }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (t.error === 'invalid_grant') {          // revoked, or older than 6 months: sign in again
      await d.batch([kvSet(d, 'sp.auth', { ...acc, access: null, broken: 'Spotify sign-in expired. Connect Spotify again.' }), logStmt(d, 'Spotify sign-in expired')]);
      throw new HttpError(401, 'Spotify sign-in expired. Connect Spotify again.');
    }
    throw new HttpError(502, 'Spotify token error: ' + (t.error_description || t.error || r.status));
  }
  const next = { ...acc, access: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000, refresh: t.refresh_token || acc.refresh, broken: null };
  await kvSet(d, 'sp.auth', next).run();      // Spotify may hand out a new refresh token: always keep the newest
  return next.access;
}

async function sp(env, d, ctx, path) {
  if (ctx.calls >= SP_BUDGET) throw new Budget();
  ctx.calls++;
  const token = ctx.token ??= await spToken(env, d);
  const r = await fetch(path.startsWith('http') ? path : SP_API + path, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 429) { ctx.wait = +r.headers.get('Retry-After') || 30; throw new Budget(); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new HttpError(r.status === 401 ? 401 : 502, `Spotify ${r.status}: ${data.error?.message || 'error'}`); e.spotify = r.status; throw e; }
  return data;
}
class Budget extends Error {}

const ITEM_FIELDS = 'next,total,items(added_at,item(id,type,name,uri,duration_ms,is_local,external_ids(isrc),album(name,release_date,images(url,width)),artists(name)),track(id,type,name,uri,duration_ms,is_local,external_ids(isrc),album(name,release_date,images(url,width)),artists(name)))';

function pickImage(imgs) {          // ~300 px if there is one, else the first
  if (!imgs?.length) return null;
  const s = [...imgs].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (s.find(i => (i.width || 0) >= 250) || s[s.length - 1]).url;
}
function spTrack(t) {
  if (!t || t.type !== 'track' || !t.id || t.is_local) return null;
  return {
    id: 'sp:' + t.id, src: 'spotify', ext: t.id, title: t.name || '', artists: (t.artists || []).map(a => a.name).join(', '),
    album: t.album?.name || '', image: pickImage(t.album?.images), dur: t.duration_ms || 0,
    isrc: t.external_ids?.isrc || null, year: (t.album?.release_date || '').slice(0, 4), url: 'https://open.spotify.com/track/' + t.id,
  };
}

/* One sync step. The job lives in kv 'sp.job':
   {phase:'lists'|'playlist'|'liked'|'done', next (url), queue [playlist ids], pl, offset, rows, started}
   A playlist is re-read only when its snapshot_id changed. Liked songs are read newest-first
   and stop at the first song already known; if the total then doesn't match, a full re-read. */
async function spStep(env, d, ctx) {
  let job = await kvGet(d, 'sp.job');
  if (!job || job.phase === 'done') job = { phase: 'lists', next: 'me/playlists?limit=50', seen: [], queue: [], started: Date.now(), newSongs: 0 };
  try {
    while (true) {
      if (job.phase === 'lists') {
        const page = await sp(env, d, ctx, job.next);
        const rows = [];
        for (const p of page.items || []) {
          if (!p) continue;
          // Which playlists share their songs isn't guessed from owner ids (they don't match /me's id
          // for every account): the playlist step asks Spotify, and a reply without items = followed only.
          rows.push({ id: 'sp:' + p.id, ext: p.id, name: p.name || 'Untitled', image: pickImage(p.images), snap: p.snapshot_id,
            total: p.items?.total ?? p.tracks?.total ?? 0, owner: p.owner?.display_name || '' });
          job.seen.push('sp:' + p.id);
        }
        if (rows.length) await d.prepare(`INSERT INTO playlists (id, src, ext, name, image, snap, total, owner, kind, readable, gone, updated)
          SELECT j->>'id', 'spotify', j->>'ext', j->>'name', j->>'image', j->>'snap', j->>'total', j->>'owner', 'playlist', 1, 0, ?
          FROM (SELECT value AS j FROM json_each(?)) WHERE true
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, image = excluded.image, snap = excluded.snap, total = excluded.total,
            owner = excluded.owner, gone = 0, updated = excluded.updated`).bind(Date.now(), JSON.stringify(rows)).run();
        job.next = page.next;
        if (!job.next) {
          // playlists no longer in the list: mark gone (kept, so nothing disappears by surprise)
          await d.prepare(`UPDATE playlists SET gone = 1 WHERE src = 'spotify' AND kind = 'playlist' AND id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(job.seen)).run();
          const { results } = await d.prepare(`SELECT id FROM playlists WHERE src = 'spotify' AND kind = 'playlist' AND gone = 0 AND (synced IS NULL OR synced != snap)`).all();
          job = { ...job, phase: 'playlist', queue: results.map(r => r.id), seen: [], pl: null };
        }
        continue;
      }
      if (job.phase === 'playlist') {
        if (!job.pl) {
          if (!job.queue.length) { job = { ...job, phase: 'liked', offset: 0, fresh: [] }; continue; }
          job.pl = job.queue.shift(); job.offset = 0;
        }
        const pl = await d.prepare('SELECT ext, snap, name FROM playlists WHERE id = ?').bind(job.pl).first();
        if (!pl) { job.pl = null; continue; }
        let page;
        try { page = await sp(env, d, ctx, `playlists/${pl.ext}/items?limit=100&offset=${job.offset}&fields=${encodeURIComponent(ITEM_FIELDS)}`); }
        catch (e) { if (e.spotify === 403 || e.spotify === 404) page = { refused: e.spotify }; else throw e; }
        if (!Array.isArray(page.items)) {   // a playlist you only follow (or one made by Spotify): no items, or 403/404
          job.refused = (job.refused || 0) + 1;
          await d.batch([d.prepare('UPDATE playlists SET readable = 0, synced = ? WHERE id = ?').bind(pl.snap, job.pl),
            d.prepare('DELETE FROM items WHERE pl = ?').bind(job.pl)]);
          job.pl = null; continue;
        }
        const tracks = [], items = [];
        (page.items || []).forEach((x, i) => {
          const t = spTrack(x.item || x.track);
          if (!t) return;
          tracks.push(t); items.push({ pl: job.pl, pos: job.offset + i, track: t.id, added: x.added_at || null });
        });
        const st = [];
        if (tracks.length) st.push(upsertTracks(d, tracks), putItems(d, items));
        job.offset += (page.items || []).length;
        if (!page.next) {
          st.push(d.prepare('DELETE FROM items WHERE pl = ? AND pos >= ?').bind(job.pl, job.offset),
            d.prepare('UPDATE playlists SET synced = ?, total = ?, readable = 1 WHERE id = ?').bind(pl.snap, page.total ?? job.offset, job.pl));
          job.pl = null;
        }
        if (st.length) await d.batch(st);
        continue;
      }
      if (job.phase === 'liked') {
        const page = await sp(env, d, ctx, `me/tracks?limit=50&offset=${job.offset}`);
        const known = new Set();
        if (!job.full && page.items?.length) {
          const keys = page.items.map(x => 'sp:' + x.track?.id + '|' + x.added_at);
          const { results } = await d.prepare(`SELECT track || '|' || added AS k FROM items WHERE pl = 'sp:liked' AND track || '|' || added IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
          results.forEach(r => known.add(r.k));
        }
        const tracks = [], items = [];let hitKnown = false;
        for (const x of page.items || []) {
          const t = spTrack(x.track);
          if (!t) continue;
          if (known.has(t.id + '|' + x.added_at)) { hitKnown = true; break; }
          // newest first; pos = save time in ms (+ a tiebreak) so new songs never shift older rows
          tracks.push(t); items.push({ pl: 'sp:liked', pos: Date.parse(x.added_at) * 10 + (items.length % 10), track: t.id, added: x.added_at });
        }
        const st = [d.prepare(`INSERT INTO playlists (id, src, ext, name, kind, readable, gone, updated, total) VALUES ('sp:liked', 'spotify', 'liked', 'Liked Songs', 'liked', 1, 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET total = excluded.total, updated = excluded.updated, gone = 0`).bind(Date.now(), page.total || 0)];
        if (tracks.length) st.push(upsertTracks(d, tracks), putItems(d, items));
        await d.batch(st);
        job.fresh = (job.fresh || 0) + tracks.length;
        job.offset += (page.items || []).length;
        if (hitKnown || !page.next) {
          const c = await d.prepare(`SELECT COUNT(*) AS n FROM items WHERE pl = 'sp:liked'`).first();
          if (c.n !== page.total && !job.full) {   // something was un-liked (or a gap): re-read everything once
            await d.prepare(`DELETE FROM items WHERE pl = 'sp:liked'`).run();
            job = { ...job, full: true, offset: 0, fresh: 0 }; continue;
          }
          const msg = `Spotify synced${job.fresh ? `: ${job.fresh} new liked song${job.fresh === 1 ? '' : 's'}` : ''}${job.refused ? ` (${job.refused} playlist${job.refused === 1 ? '' : 's'} Spotify won't share: followed or made by Spotify)` : ''}`;
          await d.batch([kvSet(d, 'sp.job', { phase: 'done', at: Date.now() }), kvSet(d, 'sp.last', Date.now()), logStmt(d, msg)]);
          return { done: true, msg };
        }
        continue;
      }
      return { done: true, msg: 'Nothing to do' };
    }
  } catch (e) {
    if (!(e instanceof Budget)) {
      await d.batch([kvSet(d, 'sp.job', job), logStmt(d, 'Sync error: ' + e.message)]);
      throw e;
    }
    await kvSet(d, 'sp.job', job).run();
    const where = job.phase === 'lists' ? 'reading your playlists' : job.phase === 'playlist' ? `reading playlists (${job.queue.length + (job.pl ? 1 : 0)} left)` : 'reading liked songs';
    return { done: false, wait: ctx.wait || 0, msg: 'Syncing Spotify: ' + where };
  }
}

/* ---------- YouTube Music (YouTube Data API v3) ----------
   YT Music playlists are YouTube playlists; "liked music" = your liked videos that are music
   (category 10). There's no album/ISRC field, but songs from "<Artist> - Topic" channels carry
   them in the description ("Provided to YouTube by … / Title · Artist / Album / Released on: …").
   Quota: 10,000 units a day; listing costs 1 unit per 50 songs, so syncing is cheap. */
const YT_API = 'https://www.googleapis.com/youtube/v3/';
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';   // read now; adding songs (a later step) needs this, not .readonly
const YT_BUDGET = 12;
const VID_FIELDS = 'items(id,snippet(title,channelTitle,categoryId,description,publishedAt,thumbnails/medium/url,thumbnails/high/url),contentDetails/duration)';

async function ytToken(env, d) {
  const acc = await kvGet(d, 'yt.auth');
  if (!acc) throw new HttpError(409, 'YouTube is not connected');
  if (acc.access && acc.exp > Date.now() + 60e3) return acc.access;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acc.refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (t.error === 'invalid_grant') {
      const why = 'YouTube sign-in expired. Connect YouTube Music again.';
      await d.batch([kvSet(d, 'yt.auth', { ...acc, access: null, broken: why }), logStmt(d, 'YouTube sign-in expired')]);
      throw new HttpError(401, why);
    }
    throw new HttpError(502, 'Google token error: ' + (t.error_description || t.error || r.status));
  }
  const next = { ...acc, access: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000, refresh: t.refresh_token || acc.refresh, broken: null };
  await kvSet(d, 'yt.auth', next).run();
  return next.access;
}
async function yt(env, d, ctx, path) {
  if (ctx.calls >= YT_BUDGET) throw new Budget();
  ctx.calls++;
  const token = ctx.yt ??= await ytToken(env, d);
  const r = await fetch(YT_API + path, { headers: { Authorization: 'Bearer ' + token } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = data.error?.errors?.[0]?.reason || '';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) { ctx.wait = 60; throw new HttpError(429, 'YouTube daily quota used up: syncing continues after midnight Pacific time'); }
    const e = new HttpError(r.status === 401 ? 401 : 502, `YouTube ${r.status}: ${data.error?.message || reason || 'error'}`); e.yt = r.status; throw e;
  }
  return data;
}
function isoDur(s) { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '') || []; return (((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000; }
const NOISE = /\s*[([](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|lyric\s*video|visuali[sz]er|hd|hq|4k|mv|m\/v|official)[^)\]]*[)\]]/gi;
function ytTrack(v) {
  if (!v?.id || !v.snippet) return null;
  const sn = v.snippet, ch = (sn.channelTitle || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  let title = sn.title || '', artists = ch, album = '', year = (sn.publishedAt || '').slice(0, 4);
  const lines = (sn.description || '').split('\n').map(l => l.trim());
  if (/^Provided to YouTube by/i.test(lines[0] || '')) {          // an official "Topic" song
    const k = lines.findIndex(l => l.includes(' · '));
    if (k > 0) {
      const parts = lines[k].split(' · ');title = parts[0];artists = parts.slice(1).join(', ') || ch;
      album = lines.slice(k + 1).find(Boolean) || '';
      if (/^℗|^Released on:|^Auto-generated/.test(album)) album = '';
    }
    const rel = (sn.description || '').match(/Released on:\s*(\d{4})/) || (sn.description || '').match(/℗\s*(\d{4})/);
    if (rel) year = rel[1];
  } else {
    const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);              // "Artist - Title (Official Video)"
    if (m) { artists = m[1].trim(); title = m[2]; }
    title = title.replace(NOISE, '').trim();
  }
  return { id: 'yt:' + v.id, src: 'youtube', ext: v.id, title, artists, album, image: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || null,
    dur: isoDur(v.contentDetails?.duration), isrc: null, year, url: 'https://music.youtube.com/watch?v=' + v.id, music: sn.categoryId === '10' };
}
async function ytVideos(env, d, ctx, ids) {
  if (!ids.length) return new Map();
  const r = await yt(env, d, ctx, `videos?part=snippet,contentDetails&id=${ids.join(',')}&fields=${encodeURIComponent(VID_FIELDS)}`);
  return new Map((r.items || []).map(v => [v.id, ytTrack(v)]).filter(([, t]) => t));
}
const PI_FIELDS = 'nextPageToken,pageInfo/totalResults,items(snippet(publishedAt,resourceId/videoId),contentDetails/videoId)';

/* Same shape as the Spotify step; job in kv 'yt.job'. A playlist is re-read when its song count
   changes, and once a day anyway (YouTube has no snapshot id). Liked: newest first, stop at the
   first known video; non-music likes are remembered in `skip` so they're not looked at again. */
async function ytStep(env, d, ctx) {
  let job = await kvGet(d, 'yt.job');
  if (!job || job.phase === 'done') job = { phase: 'lists', token: '', seen: [], started: Date.now() };
  const day = new Date().toISOString().slice(0, 10);
  try {
    while (true) {
      if (job.phase === 'lists') {
        const page = await yt(env, d, ctx, `playlists?part=snippet,contentDetails&mine=true&maxResults=50${job.token ? '&pageToken=' + job.token : ''}`);
        const rows = (page.items || []).map(p => ({ id: 'yt:' + p.id, ext: p.id, name: p.snippet?.title || 'Untitled',
          image: p.snippet?.thumbnails?.high?.url || p.snippet?.thumbnails?.medium?.url || null, total: p.contentDetails?.itemCount ?? 0,
          snap: (p.contentDetails?.itemCount ?? 0) + '@' + day, owner: p.snippet?.channelTitle || '' }));
        job.seen.push(...rows.map(r => r.id));
        if (rows.length) await d.prepare(`INSERT INTO playlists (id, src, ext, name, image, snap, total, owner, kind, readable, gone, updated)
          SELECT j->>'id', 'youtube', j->>'ext', j->>'name', j->>'image', j->>'snap', j->>'total', j->>'owner', 'playlist', 1, 0, ?
          FROM (SELECT value AS j FROM json_each(?)) WHERE true
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, image = excluded.image, snap = excluded.snap, total = excluded.total,
            owner = excluded.owner, gone = 0, updated = excluded.updated`).bind(Date.now(), JSON.stringify(rows)).run();
        job.token = page.nextPageToken || '';
        if (!job.token) {
          await d.prepare(`UPDATE playlists SET gone = 1 WHERE src = 'youtube' AND kind = 'playlist' AND id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(job.seen)).run();
          const { results } = await d.prepare(`SELECT id FROM playlists WHERE src = 'youtube' AND kind = 'playlist' AND gone = 0 AND (synced IS NULL OR synced != snap)`).all();
          job = { ...job, phase: 'playlist', queue: results.map(r => r.id), seen: [], pl: null, token: '' };
        }
        continue;
      }
      if (job.phase === 'playlist') {
        if (!job.pl) {
          if (!job.queue.length) { const me = await kvGet(d, 'yt.me'); job = { ...job, phase: 'liked', likes: me?.likes || 'LL', token: '', offset: 0, fresh: 0 }; continue; }
          job.pl = job.queue.shift();job.offset = 0;job.token = '';
        }
        const pl = await d.prepare('SELECT ext, snap FROM playlists WHERE id = ?').bind(job.pl).first();
        if (!pl) { job.pl = null; continue; }
        let page;
        try { page = await yt(env, d, ctx, `playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(pl.ext)}${job.token ? '&pageToken=' + job.token : ''}&fields=${encodeURIComponent(PI_FIELDS)}`); }
        catch (e) { if (e.yt === 403 || e.yt === 404) { await d.prepare('UPDATE playlists SET synced = snap WHERE id = ?').bind(job.pl).run(); job.pl = null; continue; } throw e; }
        const pis = (page.items || []).map(x => ({ vid: x.contentDetails?.videoId || x.snippet?.resourceId?.videoId, added: x.snippet?.publishedAt || null })).filter(x => x.vid);
        const vids = await ytVideos(env, d, ctx, [...new Set(pis.map(x => x.vid))]);
        const tracks = [...vids.values()], items = [];
        pis.forEach((x, i) => { if (vids.has(x.vid)) items.push({ pl: job.pl, pos: job.offset + i, track: 'yt:' + x.vid, added: x.added }); });   // deleted/private videos are left out
        const st = [];
        if (tracks.length) st.push(upsertTracks(d, tracks), putItems(d, items));
        job.offset += (page.items || []).length;job.token = page.nextPageToken || '';
        if (!job.token) {
          st.push(d.prepare('DELETE FROM items WHERE pl = ? AND pos >= ?').bind(job.pl, job.offset),
            d.prepare('UPDATE playlists SET synced = ? WHERE id = ?').bind(pl.snap, job.pl));
          job.pl = null;
        }
        if (st.length) await d.batch(st);
        continue;
      }
      if (job.phase === 'liked') {
        const page = await yt(env, d, ctx, `playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(job.likes)}${job.token ? '&pageToken=' + job.token : ''}&fields=${encodeURIComponent(PI_FIELDS)}`);
        const pis = (page.items || []).map(x => ({ vid: x.contentDetails?.videoId || x.snippet?.resourceId?.videoId, added: x.snippet?.publishedAt || '' })).filter(x => x.vid);
        let fresh = pis;
        if (!job.full && pis.length) {
          const keys = pis.map(x => 'yt:' + x.vid + '|' + x.added);
          const { results } = await d.prepare(`SELECT k FROM (SELECT track || '|' || added AS k FROM items WHERE pl = 'yt:liked' UNION ALL SELECT track || '|' || added FROM skip WHERE pl = 'yt:liked')
            WHERE k IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
          const known = new Set(results.map(r => r.k)), cut = pis.findIndex(x => known.has('yt:' + x.vid + '|' + x.added));
          if (cut >= 0) fresh = pis.slice(0, cut);
          job.hit = cut >= 0;
        }
        const vids = await ytVideos(env, d, ctx, [...new Set(fresh.map(x => x.vid))]);
        const tracks = [], items = [], skips = [];
        fresh.forEach((x, i) => {
          const t = vids.get(x.vid), row = { pl: 'yt:liked', pos: (Date.parse(x.added) || 0) * 10 + (i % 10), track: 'yt:' + x.vid, added: x.added };
          if (t?.music) { tracks.push(t); items.push(row); } else skips.push(row);   // not music (or no longer available)
        });
        const st = [d.prepare(`INSERT INTO playlists (id, src, ext, name, kind, readable, gone, updated, total) VALUES ('yt:liked', 'youtube', ?, 'Liked Music', 'liked', 1, 0, ?, 0)
          ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, gone = 0`).bind(job.likes, Date.now())];
        if (tracks.length) st.push(upsertTracks(d, tracks), putItems(d, items));
        if (skips.length) st.push(d.prepare(`INSERT OR REPLACE INTO skip (pl, pos, track, added) SELECT j->>'pl', j->>'pos', j->>'track', j->>'added' FROM (SELECT value AS j FROM json_each(?))`).bind(JSON.stringify(skips)));
        await d.batch(st);
        job.fresh += tracks.length;job.token = page.nextPageToken || '';
        if (job.hit || !job.token) {
          const total = page.pageInfo?.totalResults ?? 0;
          const c = await d.prepare(`SELECT (SELECT COUNT(*) FROM items WHERE pl = 'yt:liked') + (SELECT COUNT(*) FROM skip WHERE pl = 'yt:liked') AS n`).first();
          // YouTube's total can differ a little from what it actually lists: remember that gap after a
          // full read, so a full re-read only happens when something was really un-liked
          const gap = (await kvGet(d, 'yt.likedGap')) || 0;
          const complete = job.full || !job.hit;     // read to the end without meeting a known video = a full read
          if (c.n + gap !== total && !complete) {
            await d.batch([d.prepare(`DELETE FROM items WHERE pl = 'yt:liked'`), d.prepare(`DELETE FROM skip WHERE pl = 'yt:liked'`)]);
            job = { ...job, full: true, token: '', hit: false, fresh: 0 }; continue;
          }
          if (complete) await kvSet(d, 'yt.likedGap', total - c.n).run();
          const n = await d.prepare(`SELECT COUNT(*) AS n FROM items WHERE pl = 'yt:liked'`).first();
          const msg = `YouTube Music synced${job.fresh ? `: ${job.fresh} new liked song${job.fresh === 1 ? '' : 's'}` : ''}`;
          await d.batch([d.prepare(`UPDATE playlists SET total = ? WHERE id = 'yt:liked'`).bind(n.n), kvSet(d, 'yt.job', { phase: 'done', at: Date.now() }), kvSet(d, 'yt.last', Date.now()), logStmt(d, msg)]);
          return { done: true, msg };
        }
        continue;
      }
      return { done: true, msg: 'Nothing to do' };
    }
  } catch (e) {
    if (!(e instanceof Budget)) { await d.batch([kvSet(d, 'yt.job', job), logStmt(d, 'YouTube sync error: ' + e.message)]); throw e; }
    await kvSet(d, 'yt.job', job).run();
    const where = job.phase === 'lists' ? 'reading your playlists' : job.phase === 'playlist' ? `reading playlists (${job.queue.length + (job.pl ? 1 : 0)} left)` : 'reading liked music';
    return { done: false, wait: ctx.wait || 0, msg: 'Syncing YouTube Music: ' + where };
  }
}

async function ytStart(env, body, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(500, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Worker first (SETUP.md)');
  const ret = String(body?.return || '');let origin = '';
  try { origin = new URL(ret).origin; } catch (e) {}
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  if (!allowed.includes(origin)) throw new HttpError(400, 'That return address is not in ALLOWED_ORIGINS');
  const d = await db(env), state = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, '0')).join('');
  await d.batch([d.prepare(`DELETE FROM kv WHERE k LIKE 'yt.state.%' AND CAST(json_extract(v, '$.exp') AS INTEGER) < ?`).bind(Date.now()),
    kvSet(d, 'yt.state.' + state, { ret, exp: Date.now() + 15 * 6e4 })]);
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/youtube/callback', response_type: 'code', scope: YT_SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q };
}
/* Google sends the browser here (no app key on this one: the one-time state proves it's ours). */
async function ytCallback(env, url) {
  const d = await db(env), state = url.searchParams.get('state') || '';
  const saved = /^[0-9a-f]{36}$/.test(state) ? await kvGet(d, 'yt.state.' + state) : null;
  if (!saved || saved.exp < Date.now()) return new Response('This sign-in link expired. Go back to Mixtape and press Connect YouTube Music again.', { status: 400 });
  await kvDel(d, 'yt.state.' + state).run();
  const back = (q) => Response.redirect(saved.ret.split('?')[0].split('#')[0] + '?' + new URLSearchParams(q) + '#/settings', 302);
  if (url.searchParams.get('error')) return back({ yt: 'err', m: url.searchParams.get('error') === 'access_denied' ? 'YouTube sign-in was cancelled' : 'Google: ' + url.searchParams.get('error') });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: url.origin + '/youtube/callback',
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.refresh_token) return back({ yt: 'err', m: 'Google sign-in failed: ' + (t.error_description || t.error || (t.access_token ? 'no refresh token (remove Mixtape from your Google account permissions, then try again)' : r.status)) });
  if (!String(t.scope || '').includes('/auth/youtube')) return back({ yt: 'err', m: 'YouTube access was not ticked on the Google screen. Try again and allow it.' });
  await kvSet(d, 'yt.auth', { refresh: t.refresh_token, access: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 }).run();
  const ch = await fetch(YT_API + 'channels?part=snippet,contentDetails&mine=true', { headers: { Authorization: 'Bearer ' + t.access_token } }).then(x => x.json()).catch(() => ({}));
  const c = ch.items?.[0];
  if (!c) return back({ yt: 'err', m: 'This Google account has no YouTube channel. Open youtube.com once with it (it makes one), then connect again.' });
  await d.batch([kvSet(d, 'yt.me', { id: c.id, title: c.snippet?.title || '', likes: c.contentDetails?.relatedPlaylists?.likes || 'LL' }), kvDel(d, 'yt.job'), kvDel(d, 'sync.cur'),
    logStmt(d, `YouTube Music connected (${c.snippet?.title || c.id})`)]);
  return back({ yt: 'ok' });
}

/* ---------- sync entry (app or cron) ----------
   One step per call. Services take turns: Spotify's cycle, then YouTube's (kv 'sync.cur'). */
async function syncStep(env) {
  const d = await db(env);
  const [sa, ya, cur0] = await Promise.all([kvGet(d, 'sp.auth'), kvGet(d, 'yt.auth'), kvGet(d, 'sync.cur')]);
  const on = [sa && !sa.broken && 'sp', ya && !ya.broken && 'yt'].filter(Boolean);
  if (!on.length) return { done: true, msg: sa?.broken || ya?.broken || 'Nothing connected yet' };
  // a simple lease so the cron and the app don't sync at the same time
  const now = Date.now();
  const got = await d.prepare(`INSERT INTO kv (k, v) VALUES ('lock', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?`).bind(String(now + LOCK_MS), now).run();
  if (!got.meta.changes) return { done: false, wait: 5, msg: 'Another sync is running' };
  try {
    const cur = on.includes(cur0) ? cur0 : on[0];
    const r = cur === 'sp' ? await spStep(env, d, { calls: 0 }) : await ytStep(env, d, { calls: 0 });
    if (!r.done) { if (cur !== cur0) await kvSet(d, 'sync.cur', cur).run(); return r; }
    const nextSvc = on[on.indexOf(cur) + 1];
    if (nextSvc) { await kvSet(d, 'sync.cur', nextSvc).run(); return { done: false, msg: r.msg + ' · YouTube Music next' }; }
    await kvDel(d, 'sync.cur').run();
    return r;
  }
  finally {
    await d.batch([kvDel(d, 'lock'), d.prepare(`DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT ${LOG_KEEP})`)]);
  }
}

/* ---------- endpoints ---------- */
async function status(env) {
  const d = await db(env);
  const [auth, me, job, last, ya, yme, yjob, ylast, counts, log] = await Promise.all([
    kvGet(d, 'sp.auth'), kvGet(d, 'sp.me'), kvGet(d, 'sp.job'), kvGet(d, 'sp.last'),
    kvGet(d, 'yt.auth'), kvGet(d, 'yt.me'), kvGet(d, 'yt.job'), kvGet(d, 'yt.last'),
    d.prepare(`SELECT (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM playlists WHERE gone = 0) AS playlists`).first(),
    d.prepare('SELECT at, msg FROM log ORDER BY id DESC LIMIT 15').all(),
  ]);
  return {
    ok: true,
    spotify: auth ? { connected: true, name: me?.display_name || me?.id || '', broken: auth.broken || null, last, job: job?.phase || null } : { connected: false },
    youtube: ya ? { connected: true, name: yme?.title || '', broken: ya.broken || null, last: ylast, job: yjob?.phase || null } : { connected: false },
    counts, log: log.results,
  };
}

async function spConnect(env, body) {
  const refresh = String(body?.refresh_token || '');
  if (refresh.length < 20) throw new HttpError(400, 'Expected {refresh_token}');
  if (!env.SPOTIFY_CLIENT_ID) throw new HttpError(500, 'SPOTIFY_CLIENT_ID is not set in the Worker');
  const d = await db(env);
  await kvSet(d, 'sp.auth', { refresh, access: null, exp: 0 }).run();
  const token = await spToken(env, d);
  const r = await fetch(SP_API + 'me', { headers: { Authorization: 'Bearer ' + token } });
  const me = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, 'Spotify /me failed: ' + (me.error?.message || r.status));
  await d.batch([kvSet(d, 'sp.me', { id: me.id, account_id: me.account_id || null, display_name: me.display_name }), kvDel(d, 'sp.job'), logStmt(d, `Spotify connected (${me.display_name || me.id})`)]);
  return { ok: true, name: me.display_name || me.id };
}

async function ytDisconnect(env) {
  const d = await db(env);
  await d.batch([kvDel(d, 'yt.auth'), kvDel(d, 'yt.job'), kvDel(d, 'sync.cur'), logStmt(d, 'YouTube Music disconnected (library kept)')]);
  return { ok: true };
}
async function spDisconnect(env) {
  const d = await db(env);
  await d.batch([kvDel(d, 'sp.auth'), kvDel(d, 'sp.job'), logStmt(d, 'Spotify disconnected (library kept)')]);
  return { ok: true };
}

/* JSON array text of every row, built by SQLite in slices of 1500 rows (a D1 result value must
   stay under 2 MB), then joined here as plain text. */
async function jsonRows(d, cols, from) {
  const parts = [];
  for (let off = 0; ; off += 1500) {
    const r = await d.prepare(`SELECT json_group_array(json_array(${cols})) AS j, COUNT(*) AS n FROM (SELECT * FROM ${from} LIMIT 1500 OFFSET ${off})`).first();
    if (r.n) parts.push(r.j.slice(1, -1));
    if (r.n < 1500) break;
  }
  return '[' + parts.join(',') + ']';
}
async function library(env, head) {
  const d = await db(env);
  const [playlists, tracks, items] = [
    await jsonRows(d, 'id, src, name, image, total, owner, kind, readable, gone', 'playlists ORDER BY kind DESC, name'),
    await jsonRows(d, 'id, src, title, artists, album, image, dur, isrc, year, url', 'tracks ORDER BY id'),
    // playlists in their own order; liked songs newest first
    await jsonRows(d, 'pl, track, added', `items ORDER BY pl, CASE WHEN pl LIKE '%:liked' THEN -pos ELSE pos END`),
  ];
  return new Response(`{"playlists":${playlists},"tracks":${tracks},"items":${items},"at":${Date.now()}}`,
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...head } });
}

/* ---------- request handling ---------- */
function sameText(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function cors(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? {
    'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400',
  } : {};
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '', head = cors(origin, env);
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...head } });
    if (request.method === 'OPTIONS') return new Response(null, { status: head['Access-Control-Allow-Origin'] ? 204 : 403, headers: head });
    try {
      if (!env.APP_KEY) throw new HttpError(500, 'The Worker is missing APP_KEY');
      const u0 = new URL(request.url);
      if (request.method === 'GET' && u0.pathname === '/youtube/callback') return await ytCallback(env, u0);
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ') || !sameText(auth.slice(7), env.APP_KEY)) throw new HttpError(401, 'Wrong app key');
      const url = new URL(request.url), p = url.pathname, m = request.method;
      const body = () => request.json().catch(() => null);
      if (m === 'GET' && p === '/status') return reply(await status(env));
      if (m === 'GET' && p === '/config') return reply({ spotifyClientId: env.SPOTIFY_CLIENT_ID || null, youtube: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
      if (m === 'GET' && p === '/library') return await library(env, head);
      if (m === 'POST' && p === '/sync') return reply(await syncStep(env));
      if (m === 'POST' && p === '/spotify/connect') return reply(await spConnect(env, await body()));
      if (m === 'POST' && p === '/spotify/disconnect') return reply(await spDisconnect(env));
      if (m === 'POST' && p === '/youtube/start') return reply(await ytStart(env, await body(), url));
      if (m === 'POST' && p === '/youtube/disconnect') return reply(await ytDisconnect(env));
      if (m === 'GET' && p === '/spotify/token') { const d = await db(env); return reply({ token: await spToken(env, d) }); }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      return reply({ ok: false, error: e.message }, e.status || 500);
    }
  },
  // cron trigger: a few sync steps every 15 minutes (each step is small)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { try { await syncStep(env); } catch (e) { /* logged in D1 */ } })());
  },
};
