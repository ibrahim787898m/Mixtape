/* Playback. Two ways, picked automatically:
   - "browser": Spotify's Web Playback SDK turns this tab into a Spotify device (desktop browsers,
     Premium). Mixtape sends batches of up to BATCH songs to it and loads the next batch itself,
     so the queue is whatever list you started from (with its filters and sort).
   - "connect": where the SDK can't run (phone browsers, DRM turned off), Mixtape remote-controls
     your Spotify app through the Web API (Spotify Connect) and polls what's playing.
   The access token comes from the Worker (/spotify/token); the refresh token never leaves it. */
import { api } from './api.js';

const SP = 'https://api.spotify.com/v1/';
const BATCH = 50;
export const P = { mode: null, ready: false, deviceId: null, device: '', state: null, ctx: null, error: '', busy: false, vol: +(localStorage.getItem('mixtape.vol') ?? 0.7) };
let sdk = null, player = null, onChange = () => {}, tokenCache = { t: '', exp: 0 }, poll = null, ending = false;

export function onPlayerChange(fn) { onChange = fn; }
const emit = () => onChange();

async function token() {
  if (tokenCache.t && tokenCache.exp > Date.now() + 30e3) return tokenCache.t;
  const r = await api('/spotify/token');
  tokenCache = { t: r.token, exp: Date.now() + 50 * 6e4 };
  return r.token;
}
async function web(path, method = 'GET', body) {
  const t = await token();
  const r = await fetch(SP + path, { method, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204 || r.status === 202) return null;
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const m = d?.error?.message || 'error ' + r.status;
    throw new Error(r.status === 404 ? 'No Spotify device to play on. Open the Spotify app, then press play again.'
      : r.status === 403 ? 'Spotify refused to play (' + m + ')' : 'Spotify: ' + m);
  }
  return d;
}

/* Load the SDK script early (no player yet), so the first click can create the player right away. */
export function preloadSdk() {
  if (sdk) return sdk;
  sdk = new Promise((res, rej) => {
    if (window.Spotify?.Player) return res();
    window.onSpotifyWebPlaybackSDKReady = res;
    const s = document.createElement('script');s.src = 'https://sdk.scdn.co/spotify-player.js';s.async = true;
    s.onerror = () => rej(new Error("Couldn't load Spotify's player"));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('Spotify player took too long to load')), 15000);
  });
  sdk.catch(() => {});
  return sdk;
}
const mobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/* Make this tab a Spotify device. Resolves true when ready, false if it can't (then use Connect). */
function startBrowser() {
  if (P.mode === 'browser' && P.ready) return Promise.resolve(true);
  if (mobile() || !window.Spotify?.Player) return Promise.resolve(false);
  return new Promise(res => {
    let done = false;const finish = v => { if (!done) { done = true; res(v); } };
    player = new window.Spotify.Player({ name: 'Mixtape', volume: P.vol, getOAuthToken: cb => token().then(cb).catch(e => { P.error = e.message; emit(); }) });
    player.activateElement?.();            // inside the click, so the browser allows sound
    player.addListener('ready', ({ device_id }) => { P.mode = 'browser'; P.ready = true; P.deviceId = device_id; P.device = 'This browser'; emit(); finish(true); });
    player.addListener('not_ready', () => { P.ready = false; emit(); });
    player.addListener('initialization_error', () => finish(false));          // e.g. DRM switched off
    player.addListener('authentication_error', ({ message }) => { P.error = 'Spotify sign-in problem: ' + message; emit(); finish(false); });
    player.addListener('account_error', () => { P.error = 'Playing in the browser needs Spotify Premium'; emit(); finish(false); });
    player.addListener('playback_error', ({ message }) => { P.error = message; emit(); });
    player.addListener('player_state_changed', s => onSdkState(s));
    player.connect().then(ok => { if (!ok) finish(false); });
    setTimeout(() => finish(false), 12000);
  });
}

function onSdkState(s) {
  if (!s) { P.state = null; emit(); return; }
  const cur = s.track_window?.current_track;
  P.state = { id: cur ? 'sp:' + (cur.linked_from?.id || cur.id) : null, title: cur?.name || '', artists: (cur?.artists || []).map(a => a.name).join(', '),
    image: cur?.album?.images?.[0]?.url || '', paused: s.paused, pos: s.position, dur: s.duration, at: Date.now() };
  syncIndex();
  // the last song of a batch finished: carry on with the next batch from our own list
  const c = P.ctx;
  if (c && s.paused && s.position === 0 && !ending) {
    const lastUri = c.batch[c.batch.length - 1];
    if ((s.track_window?.previous_tracks || []).some(t => t.uri === lastUri || 'spotify:track:' + t.linked_from?.id === lastUri) && c.start + c.batch.length < c.list.length) {
      ending = true;
      playAt(c.start + c.batch.length).finally(() => { ending = false; });
    }
  }
  media();emit();
}
function syncIndex() {
  const c = P.ctx;if (!c || !P.state?.id) return;
  const k = c.batch.indexOf('spotify:track:' + P.state.id.slice(3));
  if (k >= 0) c.index = c.start + k;
}

/* Connect mode: find a device (the active one, else a phone/computer running Spotify). */
async function pickDevice() {
  const d = await web('me/player/devices');
  const list = (d?.devices || []).filter(x => !x.is_restricted);
  const dev = list.find(x => x.is_active) || list.find(x => /smartphone/i.test(x.type) && mobile()) || list[0];
  if (!dev) throw new Error('No Spotify device found. Open the Spotify app on this device, then press play again.');
  P.mode = 'connect';P.deviceId = dev.id;P.device = dev.name;P.ready = true;
  return dev.id;
}
async function pollConnect() {
  clearTimeout(poll);
  if (P.mode !== 'connect' || document.hidden) return;
  try {
    const s = await web('me/player');
    if (s?.item) {
      P.state = { id: 'sp:' + (s.item.linked_from?.id || s.item.id), title: s.item.name, artists: (s.item.artists || []).map(a => a.name).join(', '),
        image: s.item.album?.images?.[0]?.url || '', paused: !s.is_playing, pos: s.progress_ms, dur: s.item.duration_ms, at: Date.now() };
      P.device = s.device?.name || P.device;syncIndex();media();
    }
    emit();
  } catch (e) { /* keep the last state */ }
  poll = setTimeout(pollConnect, 3000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && P.mode === 'connect') pollConnect(); });

async function playAt(i) {
  const c = P.ctx;if (!c || i < 0 || i >= c.list.length) return;
  c.start = i;c.index = i;c.batch = c.list.slice(i, i + BATCH);
  await web('me/player/play?device_id=' + encodeURIComponent(P.deviceId), 'PUT', { uris: c.batch, offset: { position: 0 } });
  if (P.mode === 'connect') setTimeout(pollConnect, 700);
}

/* Start playing `tracks` (Mixtape track objects, in list order) from index i. */
export async function playList(tracks, i) {
  const list = [], map = [];
  tracks.forEach((t, k) => { if (t.src === 'spotify') { if (k === i) i = list.length; list.push('spotify:track:' + t.id.slice(3)); map.push(t.id); } });
  if (!list.length) throw new Error('Nothing here can be played yet');
  P.error = '';P.busy = true;emit();
  try {
    const ok = P.mode === 'browser' && P.ready ? true : await (preloadSdk().then(() => startBrowser(), () => false));
    if (!ok) await pickDevice();
    P.ctx = { list, ids: map, start: i, index: i, batch: [] };
    await playAt(i);
    if (P.mode === 'connect') pollConnect();
  } finally { P.busy = false; emit(); }
}

export async function toggle() {
  if (!P.ctx) return;
  if (P.mode === 'browser') return player.togglePlay();
  if (P.state?.paused) await web('me/player/play?device_id=' + encodeURIComponent(P.deviceId), 'PUT');
  else await web('me/player/pause', 'PUT');
  if (P.state) P.state.paused = !P.state.paused;emit();setTimeout(pollConnect, 600);
}
export async function next() {
  const c = P.ctx;if (!c) return;
  if (c.index + 1 >= c.start + c.batch.length) return playAt(c.index + 1);   // end of this batch
  if (P.mode === 'browser') return player.nextTrack();
  await web('me/player/next', 'POST');setTimeout(pollConnect, 600);
}
export async function prev() {
  const c = P.ctx;if (!c) return;
  if (now() > 3000) return seek(0);
  if (c.index - 1 < c.start) return playAt(Math.max(0, c.index - 1));
  if (P.mode === 'browser') return player.previousTrack();
  await web('me/player/previous', 'POST');setTimeout(pollConnect, 600);
}
export async function seek(ms) {
  if (!P.state) return;
  if (P.mode === 'browser') await player.seek(ms);
  else await web('me/player/seek?position_ms=' + Math.round(ms), 'PUT');
  P.state.pos = ms;P.state.at = Date.now();emit();
}
export function setVolume(v) {
  P.vol = v;localStorage.setItem('mixtape.vol', String(v));
  if (P.mode === 'browser') player?.setVolume(v);
}
/* current position in ms (counts forward between updates while playing) */
export function now() {
  const s = P.state;if (!s) return 0;
  return Math.min(s.dur || 0, s.pos + (s.paused ? 0 : Date.now() - s.at));
}
export const currentId = () => P.state?.id || null;

/* lock-screen / media keys */
function media() {
  if (!('mediaSession' in navigator) || !P.state) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: P.state.title, artist: P.state.artists, artwork: P.state.image ? [{ src: P.state.image, sizes: '300x300' }] : [] });
    navigator.mediaSession.playbackState = P.state.paused ? 'paused' : 'playing';
  } catch (e) { /* not supported */ }
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, () => f().catch(() => {})); } catch (e) {} };
  h('play', toggle);h('pause', toggle);h('nexttrack', next);h('previoustrack', prev);
}
