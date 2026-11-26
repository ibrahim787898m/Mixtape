/* Mixtape — the app. Vanilla JS modules, no build step.
   Data flow: the Worker syncs Spotify (and later YouTube Music) into D1 → GET /library →
   normalised here into L (playlists, tracks, items) → views filter/sort it in memory.
   A copy of the last library is cached in localStorage so the app opens instantly. */
import { api, apiCfg, setApiCfg } from './api.js';
import { spotifyLogin, spotifyReturn, redirectUri } from './spotify.js';
import * as Player from './player.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIBK = 'mixtape.lib', PREFK = 'mixtape.prefs';

/* ---------- icons (inline SVG, so nothing is missing on phones) ---------- */
const ICONS = {
  lib: '<path d="M4 19V5M9 19V5M14 19l-1-14M18.5 19 16 5.5"/>', heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>', note: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>', pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 6l9 6-9 6z" fill="currentColor" stroke="none"/><path d="M18 6v12"/>', prev: '<path d="M18 6l-9 6 9 6z" fill="currentColor" stroke="none"/><path d="M6 6v12"/>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>', device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const I = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

/* ---------- state ---------- */
let L = null;                          // normalised library
let ST = null;                         // last /status
let sync = { busy: false, msg: '' };
const prefs = Object.assign({ theme: 'dark', sort: 'added', dir: -1, plSort: 'order' }, JSON.parse(localStorage.getItem(PREFK) || '{}'));
const savePrefs = () => localStorage.setItem(PREFK, JSON.stringify(prefs));
const F = { q: '', src: 'all', since: 'any', decade: 'any', pl: 'any' };   // filters (per session)

function normalise(raw) {
  const playlists = raw.playlists.map(([id, src, name, image, total, owner, kind, readable, gone]) => ({ id, src, name, image, total, owner, kind, readable: !!readable, gone: !!gone }));
  const tracks = new Map();
  for (const [id, src, title, artists, album, image, dur, isrc, year, url] of raw.tracks)
    tracks.set(id, { id, src, title, artists, album, image, dur, isrc, year, url, s: `${title} ${artists} ${album}`.toLowerCase(), pls: new Set(), added: '' });
  const items = {};
  for (const [pl, tid, added] of raw.items) {
    const t = tracks.get(tid);if (!t) continue;
    (items[pl] ||= []).push({ t, added: added || '' });
    t.pls.add(pl);
    if ((added || '') > t.added) t.added = added || '';
  }
  const inLib = [...tracks.values()].filter(t => t.pls.size);
  return { playlists, byId: new Map(playlists.map(p => [p.id, p])), tracks, items, all: inLib, at: raw.at };
}
function loadCache() { try { const r = localStorage.getItem(LIBK); if (r) L = normalise(JSON.parse(r)); } catch (e) { L = null; } }
async function fetchLibrary() {
  const c = apiCfg();
  const r = await fetch(c.url + '/library', { headers: { Authorization: 'Bearer ' + c.key }, cache: 'no-store' });
  if (!r.ok) throw new Error('Library: ' + ((await r.json().catch(() => ({}))).error || r.status));
  const text = await r.text();
  L = normalise(JSON.parse(text));
  try { localStorage.setItem(LIBK, text); } catch (e) { localStorage.removeItem(LIBK); }   // too big to cache: fine, just slower to open
}

/* connected services (from /status) */
const svcs = () => ['spotify', 'youtube'].map(k => ST?.[k]).filter(x => x?.connected);
const anyOn = () => svcs().some(x => !x.broken);
const lastSync = () => Math.min(...svcs().filter(x => !x.broken).map(x => x.last || 0));

/* ---------- formatting ---------- */
const dur = ms => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function ago(t) {
  if (!t) return 'never';const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago';
}
function addedTxt(iso) {
  if (!iso) return '';const d = new Date(iso), days = (Date.now() - d) / 864e5;
  if (days < 1) return 'today';if (days < 2) return 'yesterday';if (days < 7) return Math.floor(days) + ' days ago';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}
const long = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' min' : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`; };
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2400); }

/* ---------- routing ---------- */
const route = () => { const h = location.hash.slice(2); const [v, ...rest] = h.split('/'); return { v: v || 'library', id: decodeURIComponent(rest.join('/')) }; };
window.addEventListener('hashchange', () => { $('#app').classList.remove('drawer'); F.pl = 'any'; render(); });

/* ---------- sidebar ---------- */
let plQuery = '';
function renderSide() {
  const r = route(), all = (L?.playlists || []).filter(p => !p.gone && p.kind !== 'liked');
  const lists = all.filter(p => p.readable), followed = all.filter(p => !p.readable);
  const liked = L?.byId.get('sp:liked'), ytLiked = L?.byId.get('yt:liked');
  const match = p => !plQuery || p.name.toLowerCase().includes(plQuery);
  const shown = lists.filter(match), shownF = followed.filter(match);
  const link = p => `<a href="#/pl/${encodeURIComponent(p.id)}" class="${r.id === p.id ? 'on' : ''}" title="${esc(p.name)}">
        <span class="thumb" style="${p.image ? `background-image:url('${esc(p.image)}')` : ''}">${p.image ? '' : I('note')}</span>
        <span class="nm">${esc(p.name)}</span><span class="src ${p.src}"></span></a>`;
  const dot = sync.busy ? 'busy' : svcs().some(x => x.broken) ? 'err' : anyOn() ? 'ok' : '';
  $('#syncDotM').className = 'syncdot ' + dot;
  $('#side').innerHTML = `
    <div class="brand"><span class="logo"></span>Mixtape</div>
    <nav class="nav">
      <a href="#/library" class="${r.v === 'library' ? 'on' : ''}">${I('lib')} Library <span class="n">${L ? L.all.length.toLocaleString() : ''}</span></a>
      ${liked ? `<a href="#/pl/sp:liked" class="${r.id === 'sp:liked' ? 'on' : ''}">${I('heart')} Liked Songs <span class="src spotify" style="margin:0 0 0 2px"></span><span class="n">${(L.items['sp:liked'] || []).length.toLocaleString()}</span></a>` : ''}
      ${ytLiked ? `<a href="#/pl/yt:liked" class="${r.id === 'yt:liked' ? 'on' : ''}">${I('heart')} Liked Music <span class="src youtube" style="margin:0 0 0 2px"></span><span class="n">${(L.items['yt:liked'] || []).length.toLocaleString()}</span></a>` : ''}
      <a href="#/settings" class="${r.v === 'settings' ? 'on' : ''}">${I('gear')} Settings</a>
    </nav>
    <div class="sechead">Playlists <span class="grow"></span><span class="mono">${lists.length || ''}</span></div>
    ${all.length > 8 ? `<input class="plfilter" id="plq" placeholder="Find a playlist" value="${esc(plQuery)}">` : ''}
    <div class="pl">${shown.map(link).join('')
      || `<div class="faint" style="padding:6px 10px;font-size:13px">${L ? (plQuery ? 'No playlists match.' : 'No playlists of your own yet.') : 'Connect a service to see your playlists.'}</div>`}
      ${followed.length ? `<div class="sechead" style="margin-top:16px" title="Made by other people or by Spotify. Spotify doesn't share their songs with apps.">Followed on Spotify <span class="grow"></span><span class="mono">${followed.length}</span></div>
        <div class="followed">${shownF.map(link).join('') || '<div class="faint" style="padding:6px 10px;font-size:13px">No playlists match.</div>'}</div>` : ''}</div>
    <div class="sidefoot"><span class="syncdot ${dot}"></span><span class="grow muted" id="syncTxt">${esc(syncLine())}</span>
      ${apiCfg() && anyOn() ? `<button class="iconbtn" style="width:32px;height:32px;border-radius:9px;border:1px solid var(--line);background:var(--panel);display:grid;place-items:center;cursor:pointer" data-act="sync" title="Sync now" ${sync.busy ? 'disabled' : ''}>${I('sync')}</button>` : ''}</div>`;
  const q = $('#plq');
  if (q) q.oninput = () => { plQuery = q.value.toLowerCase(); const pos = q.selectionStart; renderSide(); const n = $('#plq'); n.focus(); n.setSelectionRange(pos, pos); };
}
function syncLine() {
  if (sync.busy) return sync.msg || 'Syncing…';
  if (!apiCfg()) return 'Not set up';
  if (ST?.spotify?.broken) return 'Spotify needs a new sign-in';
  if (ST?.youtube?.broken) return 'YouTube needs a new sign-in';
  if (!anyOn()) return 'No service connected';
  return 'Synced ' + ago(lastSync());
}

/* ---------- song lists ---------- */
const SORTS = {
  added: (a, b) => (a.added > b.added ? 1 : a.added < b.added ? -1 : 0),
  title: (a, b) => a.t.title.localeCompare(b.t.title, undefined, { sensitivity: 'base' }),
  artist: (a, b) => a.t.artists.localeCompare(b.t.artists, undefined, { sensitivity: 'base' }) || a.t.title.localeCompare(b.t.title),
  album: (a, b) => a.t.album.localeCompare(b.t.album, undefined, { sensitivity: 'base' }),
  year: (a, b) => (a.t.year || '').localeCompare(b.t.year || ''),
  dur: (a, b) => a.t.dur - b.t.dur,
  order: (a, b) => a.n - b.n,
};
const SINCE = { any: 0, '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
let rows = [];   // the filtered list on screen

function baseRows(r) {
  if (r.v === 'pl') return (L.items[r.id] || []).map((x, n) => ({ t: x.t, added: x.added, n }));
  return L.all.map((t, n) => ({ t, added: t.added, n }));
}
function applyFilters(list, inPlaylist) {
  const words = F.q.toLowerCase().split(/\s+/).filter(Boolean), cut = SINCE[F.since] ? new Date(Date.now() - SINCE[F.since] * 864e5).toISOString() : '';
  let out = list.filter(x => (!words.length || words.every(w => x.t.s.includes(w)))
    && (F.src === 'all' || x.t.src === F.src)
    && (!cut || x.added >= cut)
    && (F.decade === 'any' || (x.t.year && x.t.year.slice(0, 3) === F.decade.slice(0, 3)))
    && (inPlaylist || F.pl === 'any' || x.t.pls.has(F.pl)));
  const key = inPlaylist && prefs.plSort === 'order' ? 'order' : prefs.sort, dir = key === 'order' ? 1 : prefs.dir;
  const fn = SORTS[key] || SORTS.added;
  return out.sort((a, b) => fn(a, b) * dir || a.n - b.n);
}

function viewSongs(r) {
  const pl = r.v === 'pl' ? L.byId.get(r.id) : null;
  if (r.v === 'pl' && !pl) return `<div class="wrap"><div class="empty"><h3>Playlist not found</h3><p>It may have been deleted. <a href="#/library" style="color:var(--acc)">Back to the library</a></p></div></div>`;
  const base = baseRows(r);
  rows = applyFilters(base, !!pl);
  const decades = [...new Set(base.map(x => x.t.year && x.t.year.slice(0, 3) + '0s').filter(Boolean))].sort().reverse();
  const plOpts = L.playlists.filter(p => !p.gone && L.items[p.id]?.length);
  const liked = pl?.kind === 'liked', totalDur = base.reduce((a, x) => a + (x.t.dur || 0), 0);
  const hero = pl ? `<div class="hero"><div class="cover ${liked ? 'liked' : ''}" style="${pl.image ? `background-image:url('${esc(pl.image)}')` : ''}">${liked ? I('heart') : pl.image ? '' : I('note')}</div>
      <div><div class="kicker">${liked ? 'Liked songs' : 'Playlist'}</div><h1>${esc(pl.name)}</h1>
      <div class="meta"><span class="badge ${pl.src}">${pl.src === 'spotify' ? 'Spotify' : 'YouTube Music'}</span>${pl.owner && !liked ? `<span>by ${esc(pl.owner)}</span>·` : ''}
      <span>${plural(base.length, 'song')}</span>·<span>${long(totalDur)}</span>
      </div></div></div>`
    : `<div class="hero"><div><div class="kicker">Everything, in one place</div><h1>Library</h1>
      <div class="meta"><span>${plural(base.length, 'song')}</span>·<span>${plural(L.playlists.filter(p => !p.gone && p.readable).length, 'playlist')}</span>·<span>${long(totalDur)}</span></div></div></div>`;
  const chip = (k, v, label) => `<button class="chip ${F[k] === v ? 'on' : ''}" data-act="f" data-k="${k}" data-v="${v}">${label}</button>`;
  const sortKey = pl && prefs.plSort === 'order' ? 'order' : prefs.sort;
  const th = (k, label) => `<button class="${sortKey === k ? 'on' : ''}" data-act="sort" data-k="${k}">${label}${sortKey === k && k !== 'order' ? I(prefs.dir > 0 ? 'up' : 'down') : ''}</button>`;
  if (pl && !pl.readable) {
    const open = pl.src === 'spotify' ? 'https://open.spotify.com/playlist/' + encodeURIComponent(pl.id.replace(/^sp:/, '')) : '#';
    return `<div class="page">${hero.replace(`<span>${plural(base.length, 'song')}</span>·<span>${long(totalDur)}</span>`, '<span>Followed</span>')}
      <div class="wrap" style="padding-top:6px"><div class="card" style="max-width:620px">
        <h3>Spotify doesn't share this playlist's songs</h3>
        <p>It was made by ${pl.owner ? esc(pl.owner) : 'someone else'}, and since February 2026 Spotify only lets apps read playlists you created or collaborate on.</p>
        <p style="margin-top:10px"><b>To have it in Mixtape:</b> in Spotify, open it → select all songs → right-click → <b>Add to playlist</b> → <b>New playlist</b>. Your copy shows up here on the next sync (it won't follow changes to the original). If a friend made it, ask them to make you a collaborator instead: that stays live.</p>
        <div class="btns"><a class="btn sp" href="${open}" target="_blank" rel="noopener">${I('ext')} Open in Spotify</a></div></div></div></div>`;
  }
  return `<div class="page">${hero}
    <div class="tools">
      <label class="search">${I('search')}<input id="q" placeholder="Search songs, artists, albums" value="${esc(F.q)}" autocomplete="off">${F.q ? `<button class="chip" style="height:24px;padding:0 6px;border:0" data-act="clearq" aria-label="Clear">${I('x')}</button>` : ''}</label>
      <div class="chips">${chip('src', 'all', 'All')}${chip('src', 'spotify', '<span class="src spotify" style="margin:0"></span>Spotify')}${chip('src', 'youtube', '<span class="src youtube" style="margin:0"></span>YouTube')}</div>
      <select class="chip" data-act="fsel" data-k="since"><option value="any">Added: any time</option>${[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 3 months'], ['1y', 'Last year']].map(([v, l]) => `<option value="${v}" ${F.since === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${decades.length > 1 ? `<select class="chip" data-act="fsel" data-k="decade"><option value="any">Any year</option>${decades.map(d => `<option value="${d}" ${F.decade === d ? 'selected' : ''}>${d}</option>`).join('')}</select>` : ''}
      ${!pl && plOpts.length ? `<select class="chip" data-act="fsel" data-k="pl"><option value="any">In any playlist</option>${plOpts.map(p => `<option value="${esc(p.id)}" ${F.pl === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      ${pl && !liked ? `<select class="chip" data-act="plsort"><option value="order" ${prefs.plSort === 'order' ? 'selected' : ''}>Playlist order</option><option value="custom" ${prefs.plSort !== 'order' ? 'selected' : ''}>Sorted by column</option></select>` : ''}
      <span class="count">${rows.length === base.length ? plural(rows.length, 'song') : `${rows.length.toLocaleString()} of ${plural(base.length, 'song')}`}</span>
    </div>
    <div class="list" id="list">
      <div class="thead"><span style="text-align:right">#</span>${th('title', 'Title')}${th('album', 'Album')}${th('added', 'Added')}<span>On</span>${th('dur', 'Length')}<span></span></div>
      <div class="rows" id="rows" style="height:${rows.length * ROW()}px"></div>
      ${rows.length ? '' : `<div class="empty"><h3>${base.length ? 'No songs match' : 'No songs yet'}</h3><p>${base.length ? 'Try clearing a filter.' : 'They appear here after the first sync.'}</p></div>`}
    </div></div>`;
}

/* only the rows in view are in the page, so 10,000 songs scroll smoothly */
const ROW = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 58;
let painted = '';
function paintRows(force) {
  const list = $('#list'), box = $('#rows');if (!list || !box) return;
  const h = ROW(), head = 36, top = Math.max(0, list.scrollTop - head), first = Math.max(0, Math.floor(top / h) - 8);
  const last = Math.min(rows.length, Math.ceil((top + list.clientHeight) / h) + 8);
  if (!force && painted === first + ':' + last && box.childElementCount) return;   // same window: nothing to redraw
  painted = first + ':' + last;
  let html = '';
  for (let i = first; i < last; i++) {
    const x = rows[i], t = x.t, on = t.id === Player.currentId();
    html += `<div class="row ${on ? 'now' : ''}" data-i="${i}" style="top:${i * h}px" title="Play"><span class="idx">${on && !Player.P.state?.paused ? '<span class="eq"><i></i><i></i><i></i></span>' : `<span class="n">${i + 1}</span>`}${I('play')}</span>
      <div class="t"><span class="art" style="${t.image ? `background-image:url('${esc(t.image)}')` : ''}"></span><div class="tt"><div class="ti">${esc(t.title)}</div><div class="ar">${esc(t.artists)}</div></div></div>
      <span class="al">${esc(t.album)}</span><span class="add">${esc(addedTxt(x.added))}</span>
      <span class="srcs"><span class="pill ${t.src}" title="${t.src === 'spotify' ? 'On Spotify' : 'On YouTube Music'}">${t.src === 'spotify' ? 'S' : 'YT'}</span></span>
      <span class="dur">${dur(t.dur)}</span>
      <a class="go" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open in ${t.src === 'spotify' ? 'Spotify' : 'YouTube Music'}">${I('ext')}</a></div>`;
  }
  box.innerHTML = html;
}

/* ---------- player bar ---------- */
const mmss = ms => dur(ms);
function renderPlayer() {
  const el = $('#player'), P = Player.P, s = P.state;
  if (!el) return;
  if (!P.ctx && !s) { el.hidden = true; document.body.classList.remove('playing'); return; }
  el.hidden = false;document.body.classList.add('playing');
  const t = s?.id && L?.tracks.get(s.id);
  el.innerHTML = `
    <div class="pnow">${s ? `<span class="art" style="background-image:url('${esc(t?.image || s.image)}')"></span>
      <div class="tt"><div class="ti">${esc(s.title)}</div><div class="ar">${esc(s.artists)}</div></div>` : `<div class="tt"><div class="ar">${P.busy ? 'Starting…' : ''}</div></div>`}</div>
    <div class="pmid">
      <div class="pbtns"><button class="pb" data-act="pPrev" aria-label="Previous">${I('prev')}</button>
        <button class="pb big" data-act="pToggle" aria-label="${s?.paused === false ? 'Pause' : 'Play'}">${I(s && !s.paused ? 'pause' : 'play')}</button>
        <button class="pb" data-act="pNext" aria-label="Next">${I('next')}</button></div>
      <div class="pbar"><span class="mono" id="pPos">${mmss(Player.now())}</span>
        <input type="range" id="pSeek" min="0" max="${s?.dur || 0}" value="${Player.now()}" step="1000" aria-label="Seek">
        <span class="mono">${mmss(s?.dur || 0)}</span></div>
    </div>
    <div class="pright"><span class="pdev" title="Playing on">${I(P.mode === 'connect' ? 'phone' : 'device')}<span>${esc(P.device || '')}</span></span>
      ${P.mode === 'browser' ? `<span class="pvol">${I('vol')}<input type="range" id="pVol" min="0" max="1" step="0.05" value="${P.vol}" aria-label="Volume"></span>` : ''}</div>`;
  const seekEl = $('#pSeek');
  seekEl.oninput = () => { seekEl._drag = true; $('#pPos').textContent = mmss(+seekEl.value); };
  seekEl.onchange = () => { seekEl._drag = false; Player.seek(+seekEl.value).catch(e => toast(e.message)); };
  const v = $('#pVol');if (v) v.oninput = () => Player.setVolume(+v.value);
  if (P.error) { toast(P.error); P.error = ''; }
}
setInterval(() => {           // move the seek bar between updates
  const s = Player.P.state, el = $('#pSeek');
  if (!s || !el || el._drag) return;
  el.value = Player.now();$('#pPos').textContent = mmss(Player.now());
}, 500);
let lastPlaying = null;
Player.onPlayerChange(() => {
  renderPlayer();
  const key = Player.currentId() + ':' + Player.P.state?.paused;
  if (key !== lastPlaying) { lastPlaying = key; paintRows(true); }
});
const playErr = e => toast(e.message);

/* ---------- settings / onboarding ---------- */
function workerCard(first) {
  const c = apiCfg();
  return `<div class="card"><h3>Your Mixtape Worker <span class="status ${c ? 'on' : 'off'}">${c ? '● connected' : '○ not set up'}</span></h3>
    <p>The private Cloudflare Worker that keeps your library and syncs it every 15 minutes. Setup steps: <span class="mono">worker/SETUP.md</span>.</p>
    <div class="field"><label>Worker address</label><input id="wUrl" placeholder="https://mixtape-api.you.workers.dev" value="${esc(c?.url || '')}" autocomplete="off"></div>
    <div class="field"><label>App key</label><input id="wKey" type="password" placeholder="${c ? '•••••••• (saved)' : 'the APP_KEY you set in the Worker'}" autocomplete="off"></div>
    <div class="err" id="wErr"></div>
    <div class="btns"><button class="btn pri" data-act="wSave">${first ? 'Connect' : 'Save & test'}</button>${c ? '<button class="btn danger" data-act="wOff">Forget on this device</button>' : ''}</div></div>`;
}
function spotifyCard() {
  const s = ST?.spotify, on = s?.connected;
  return `<div class="card"><h3><span class="src spotify" style="margin:0;width:10px;height:10px"></span>Spotify
      <span class="status ${s?.broken ? 'bad' : on ? 'on' : 'off'}">${s?.broken ? '● sign in again' : on ? '● connected' : '○ not connected'}</span></h3>
    ${s?.broken ? `<p style="color:var(--err)">${esc(s.broken)}</p>` : on ? `<p>Signed in as <b>${esc(s.name)}</b>. Last sync ${esc(ago(s.last))}. Your playlists and liked songs sync every 15 minutes.</p>`
      : '<p>Sign in once; the Worker keeps the login (Spotify asks again after 6 months).</p>'}
    <div class="btns"><button class="btn sp" data-act="spLogin" ${apiCfg() ? '' : 'disabled'}>${on ? 'Sign in again' : 'Connect Spotify'}</button>
      ${on ? `<button class="btn" data-act="sync" ${sync.busy ? 'disabled' : ''}>${I('sync')} Sync now</button><button class="btn danger" data-act="spOff">Disconnect</button>` : ''}</div>
    ${sync.busy ? `<div class="faint mono" style="font-size:12.5px;margin-top:12px">${esc(sync.msg)}</div><div class="progress"><i></i></div>` : ''}
    <p class="faint" style="font-size:12.5px;margin-top:12px">Redirect URI for the Spotify app: <span class="mono">${esc(redirectUri())}</span></p></div>`;
}
function youtubeCard() {
  const s = ST?.youtube, on = s?.connected;
  return `<div class="card"><h3><span class="src youtube" style="margin:0;width:10px;height:10px"></span>YouTube Music
      <span class="status ${s?.broken ? 'bad' : on ? 'on' : 'off'}">${s?.broken ? '● sign in again' : on ? '● connected' : '○ not connected'}</span></h3>
    ${s?.broken ? `<p style="color:var(--err)">${esc(s.broken)}</p>` : on ? `<p>Signed in as <b>${esc(s.name)}</b>. Last sync ${esc(ago(s.last))}. Your playlists and liked music sync every 15 minutes.</p>`
      : '<p>Sign in with the Google account you use for YouTube Music. The Worker keeps the login.</p>'}
    <div class="btns"><button class="btn" style="background:var(--yt);border-color:var(--yt);color:#fff" data-act="ytLogin" ${apiCfg() ? '' : 'disabled'}>${on ? 'Sign in again' : 'Connect YouTube Music'}</button>
      ${on ? `<button class="btn" data-act="sync" ${sync.busy ? 'disabled' : ''}>${I('sync')} Sync now</button><button class="btn danger" data-act="ytOff">Disconnect</button>` : ''}</div>
    <p class="faint" style="font-size:12.5px;margin-top:12px">"Liked Music" is your liked videos that are music; other liked videos are left out.</p></div>`;
}
function viewSettings() {
  const log = ST?.log || [];
  return `<div class="wrap"><h2>Settings</h2><p class="muted">Services, sync and this device.</p><div class="grid">
    ${workerCard(false)}${spotifyCard()}
    ${youtubeCard()}
    <div class="card"><h3>Appearance</h3><div class="chips">${['dark', 'light', 'auto'].map(t => `<button class="chip ${prefs.theme === t ? 'on' : ''}" data-act="theme" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
    <div class="card"><h3>Recent activity</h3>${log.length ? `<div class="log">${log.map(l => `<div><span>${esc(new Date(l.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>${esc(l.msg)}</div>`).join('')}</div>` : '<p>Nothing yet.</p>'}</div>
  </div></div>`;
}
function viewWelcome() {
  return `<div class="wrap"><div class="onb"><div class="brand"><span class="logo"></span>Mixtape</div>
    <p class="muted" style="font-size:16px;margin-bottom:20px">All your songs from Spotify and YouTube Music, in one place.</p>
    ${!apiCfg() ? workerCard(true) : spotifyCard() + '<div style="height:14px"></div>' + youtubeCard()}
    <ol class="steps" style="margin-top:18px"><li${apiCfg() ? ' style="text-decoration:line-through"' : ''}>Connect your Worker</li><li>Connect Spotify and/or YouTube Music</li><li>Your library fills in (first sync takes a minute)</li></ol></div></div>`;
}

/* ---------- render ---------- */
function render() {
  document.documentElement.dataset.theme = prefs.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : prefs.theme;
  renderSide();
  const r = route(), main = $('#main');
  const keepScroll = main.dataset.route === location.hash ? $('#list')?.scrollTop : 0;
  if (r.v === 'settings') main.innerHTML = viewSettings();
  else if (!apiCfg() || !L || (!L.all.length && !anyOn())) main.innerHTML = viewWelcome();
  else main.innerHTML = viewSongs(r);
  main.dataset.route = location.hash;
  const list = $('#list');
  if (list) { list.scrollTop = keepScroll || 0; list.onscroll = () => paintRows(); paintRows(true); }
  const q = $('#q');
  if (q) q.oninput = () => { F.q = q.value; clearTimeout(q._t); q._t = setTimeout(() => { const pos = q.selectionStart; render(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); }, 120); };
}
window.addEventListener('resize', () => paintRows());

/* ---------- sync ---------- */
async function refreshStatus() { try { ST = await api('/status'); } catch (e) { ST = ST || null; sync.msg = e.message; } }
async function runSync(manual) {
  if (sync.busy || !apiCfg()) return;
  sync = { busy: true, msg: 'Syncing…' };render();
  let steps = 0, err = '';
  try {
    for (let i = 0; i < 60; i++) {
      const r = await api('/sync', {});steps++;
      sync.msg = r.msg || 'Syncing…';const t = $('#syncTxt');if (t) t.textContent = sync.msg;
      if (r.done) break;
      await sleep(r.wait ? r.wait * 1000 : 250);
    }
  } catch (e) { err = e.message; }
  await refreshStatus();
  if (steps) { try { await fetchLibrary(); } catch (e) { err = err || e.message; } }
  sync = { busy: false, msg: '' };render();
  if (err) toast(err); else if (manual) toast('Library up to date');
}

/* ---------- actions ---------- */
const A = {
  drawer: () => $('#app').classList.toggle('drawer'),
  f: d => { F[d.k] = d.v; render(); },
  clearq: () => { F.q = ''; render(); },
  sort: d => { if (d.k === prefs.sort) prefs.dir = -prefs.dir; else { prefs.sort = d.k; prefs.dir = d.k === 'added' ? -1 : 1; } prefs.plSort = 'custom'; savePrefs(); render(); },
  theme: d => { prefs.theme = d.v; savePrefs(); render(); },
  sync: () => runSync(true),
  pToggle: () => Player.toggle().catch(playErr),
  pNext: () => Player.next().catch(playErr),
  pPrev: () => Player.prev().catch(playErr),
  async wSave() {
    const url = $('#wUrl').value.trim().replace(/\/+$/, ''), key = $('#wKey').value.trim() || apiCfg()?.key || '';
    const err = $('#wErr');err.textContent = '';
    if (!/^https:\/\/[^\s/]+$/.test(url) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) { err.textContent = 'Paste the Worker address, like https://mixtape-api.you.workers.dev'; return; }
    if (key.length < 24) { err.textContent = 'The app key looks too short'; return; }
    try { ST = await api('/status', undefined, { url, key }); setApiCfg({ url, key }); toast('Worker connected'); await fetchLibrary(); render(); if (anyOn()) runSync(); }
    catch (e) { err.textContent = e.message; }
  },
  wOff: () => { if (!confirm('Forget the Worker on this device? Nothing in the Worker or your music apps changes.')) return; setApiCfg(null); localStorage.removeItem(LIBK); L = null; ST = null; render(); },
  async spLogin() {
    try { const c = await api('/config'); if (!c.spotifyClientId) throw new Error('Set SPOTIFY_CLIENT_ID in the Worker first (SETUP.md step 3)'); await spotifyLogin(c.spotifyClientId); }
    catch (e) { toast(e.message); }
  },
  async ytLogin() {
    try { const r = await api('/youtube/start', { return: location.origin + location.pathname }); location.href = r.url; }
    catch (e) { toast(e.message); }
  },
  async ytOff() {
    if (!confirm('Disconnect YouTube Music? Your Mixtape library stays; it just stops updating from YouTube.')) return;
    try { await api('/youtube/disconnect', {}); await refreshStatus(); render(); toast('YouTube Music disconnected'); } catch (e) { toast(e.message); }
  },
  async spOff() {
    if (!confirm('Disconnect Spotify? Your Mixtape library stays; it just stops updating from Spotify.')) return;
    try { await api('/spotify/disconnect', {}); await refreshStatus(); render(); toast('Spotify disconnected'); } catch (e) { toast(e.message); }
  },
};
document.addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (row && !e.target.closest('a')) {   // click a song: play from here
    const t = rows[+row.dataset.i]?.t;
    if (t?.src === 'youtube') { window.open(t.url, '_blank', 'noopener'); return; }   // YouTube songs play inside Mixtape in a later step
    Player.playList(rows.map(x => x.t), +row.dataset.i).catch(playErr); return;
  }
  const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'SELECT') return; const f = A[el.dataset.act]; if (f) { e.preventDefault(); f(el.dataset, e); }
});
document.addEventListener('change', e => {
  const el = e.target;if (el.tagName !== 'SELECT') return;
  if (el.dataset.act === 'fsel') { F[el.dataset.k] = el.value; render(); }
  if (el.dataset.act === 'plsort') { prefs.plSort = el.value; savePrefs(); render(); }
});
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { const q = $('#q'); if (q) { e.preventDefault(); q.focus(); } }
  if (e.key === 'Escape' && document.activeElement.id === 'q') { F.q = ''; render(); }
  if (e.key === ' ' && Player.P.ctx && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); Player.toggle().catch(playErr); }
});
document.addEventListener('visibilitychange', () => {   // back to the app after a while: catch up
  if (!document.hidden && apiCfg() && anyOn() && Date.now() - lastSync() > 10 * 6e4) runSync();
});

/* ---------- start ---------- */
(async function start() {
  loadCache();render();
  let ret = null, ytRet = null;
  const q = new URLSearchParams(location.search);
  if (q.has('yt')) {           // back from Google sign-in (via the Worker)
    ytRet = q.get('yt');if (ytRet !== 'ok') toast(q.get('m') || 'YouTube sign-in failed');else toast('YouTube Music connected');
    history.replaceState(null, '', location.pathname + location.hash);
  }
  try { ret = await spotifyReturn(); } catch (e) { toast(e.message); }
  if (!apiCfg()) return;
  if (ret) {
    try { const r = await api('/spotify/connect', { refresh_token: ret }); toast('Spotify connected: ' + r.name); }
    catch (e) { toast(e.message); }
  }
  await refreshStatus();
  if (!L) { try { await fetchLibrary(); } catch (e) { toast(e.message); } }
  render();
  if (ST?.spotify?.connected && !ST.spotify.broken) Player.preloadSdk();   // ready for the first click
  if (anyOn() && (ret || ytRet === 'ok' || Date.now() - lastSync() > 5 * 6e4)) runSync();
})();
