/* Mixtape API — Cloudflare Worker (paste this whole file into the Worker editor).

   Mixtape (the web app) keeps one library of the songs in your Spotify and YouTube Music
   playlists. This Worker holds the music-service logins, keeps the library in a D1 database,
   and syncs it every 15 minutes (cron trigger) and when the app asks.

     GET  /status                 → connected services, library counts, sync progress, recent log
     GET  /config                 → the Spotify client id (public), so the app needs no code edits
     POST /spotify/connect        {refresh_token}  → store a Spotify login (from the app's PKCE sign-in)
     POST /spotify/disconnect     → forget the Spotify login (the library stays)
     GET  /spotify/token          → a fresh Spotify access token (for playback in the app)
     POST /sync                   → run one sync step; call again while {done:false}
     GET  /library                → the whole library (playlists, tracks, playlist items)

   Settings (Worker → Settings → Variables and Secrets):
     Secret:  APP_KEY            a long random string; the same one goes into Mixtape → Settings
     Text:    ALLOWED_ORIGINS    e.g. https://mixtape.example.com,http://127.0.0.1:8000
              SPOTIFY_CLIENT_ID  from developer.spotify.com (not secret)
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
  if (!r.ok) throw new HttpError(r.status === 401 ? 401 : 502, `Spotify ${r.status}: ${data.error?.message || 'error'}`);
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
  const me = await kvGet(d, 'sp.me');
  if (!job || job.phase === 'done') job = { phase: 'lists', next: 'me/playlists?limit=50', seen: [], queue: [], started: Date.now(), newSongs: 0 };
  try {
    while (true) {
      if (job.phase === 'lists') {
        const page = await sp(env, d, ctx, job.next);
        const rows = [];
        for (const p of page.items || []) {
          if (!p) continue;
          const mine = p.owner?.id === me?.id || p.collaborative;
          rows.push({ id: 'sp:' + p.id, ext: p.id, name: p.name || 'Untitled', image: pickImage(p.images), snap: p.snapshot_id,
            total: p.items?.total ?? p.tracks?.total ?? 0, owner: p.owner?.display_name || '', readable: mine ? 1 : 0 });
          job.seen.push('sp:' + p.id);
        }
        if (rows.length) await d.prepare(`INSERT INTO playlists (id, src, ext, name, image, snap, total, owner, kind, readable, gone, updated)
          SELECT j->>'id', 'spotify', j->>'ext', j->>'name', j->>'image', j->>'snap', j->>'total', j->>'owner', 'playlist', j->>'readable', 0, ?
          FROM (SELECT value AS j FROM json_each(?)) WHERE true
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, image = excluded.image, snap = excluded.snap, total = excluded.total,
            owner = excluded.owner, readable = excluded.readable, gone = 0, updated = excluded.updated`).bind(Date.now(), JSON.stringify(rows)).run();
        job.next = page.next;
        if (!job.next) {
          // playlists no longer in the list: mark gone (kept, so nothing disappears by surprise)
          await d.prepare(`UPDATE playlists SET gone = 1 WHERE src = 'spotify' AND kind = 'playlist' AND id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(job.seen)).run();
          const { results } = await d.prepare(`SELECT id FROM playlists WHERE src = 'spotify' AND kind = 'playlist' AND gone = 0 AND readable = 1 AND (synced IS NULL OR synced != snap)`).all();
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
        const page = await sp(env, d, ctx, `playlists/${pl.ext}/items?limit=100&offset=${job.offset}&fields=${encodeURIComponent(ITEM_FIELDS)}`);
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
            d.prepare('UPDATE playlists SET synced = ?, total = ? WHERE id = ?').bind(pl.snap, page.total ?? job.offset, job.pl));
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
          const msg = `Spotify synced${job.newSongs || job.fresh ? `: ${job.fresh || 0} new liked song${job.fresh === 1 ? '' : 's'}` : ''}`;
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

/* ---------- sync entry (app or cron) ---------- */
async function syncStep(env) {
  const d = await db(env);
  const auth = await kvGet(d, 'sp.auth');
  if (!auth || auth.broken) return { done: true, msg: auth?.broken || 'Nothing connected yet' };
  // a simple lease so the cron and the app don't sync at the same time
  const now = Date.now();
  const got = await d.prepare(`INSERT INTO kv (k, v) VALUES ('lock', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?`).bind(String(now + LOCK_MS), now).run();
  if (!got.meta.changes) return { done: false, wait: 5, msg: 'Another sync is running' };
  try { return await spStep(env, d, { calls: 0 }); }
  finally {
    await d.batch([kvDel(d, 'lock'), d.prepare(`DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT ${LOG_KEEP})`)]);
  }
}

/* ---------- endpoints ---------- */
async function status(env) {
  const d = await db(env);
  const [auth, me, job, last, counts, log] = await Promise.all([
    kvGet(d, 'sp.auth'), kvGet(d, 'sp.me'), kvGet(d, 'sp.job'), kvGet(d, 'sp.last'),
    d.prepare(`SELECT (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM playlists WHERE gone = 0) AS playlists`).first(),
    d.prepare('SELECT at, msg FROM log ORDER BY id DESC LIMIT 15').all(),
  ]);
  return {
    ok: true,
    spotify: auth ? { connected: true, name: me?.display_name || me?.id || '', broken: auth.broken || null, last, job: job?.phase || null } : { connected: false },
    youtube: { connected: false },
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
  await d.batch([kvSet(d, 'sp.me', { id: me.id, display_name: me.display_name }), kvDel(d, 'sp.job'), logStmt(d, `Spotify connected (${me.display_name || me.id})`)]);
  return { ok: true, name: me.display_name || me.id };
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
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ') || !sameText(auth.slice(7), env.APP_KEY)) throw new HttpError(401, 'Wrong app key');
      const url = new URL(request.url), p = url.pathname, m = request.method;
      const body = () => request.json().catch(() => null);
      if (m === 'GET' && p === '/status') return reply(await status(env));
      if (m === 'GET' && p === '/config') return reply({ spotifyClientId: env.SPOTIFY_CLIENT_ID || null });
      if (m === 'GET' && p === '/library') return await library(env, head);
      if (m === 'POST' && p === '/sync') return reply(await syncStep(env));
      if (m === 'POST' && p === '/spotify/connect') return reply(await spConnect(env, await body()));
      if (m === 'POST' && p === '/spotify/disconnect') return reply(await spDisconnect(env));
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
