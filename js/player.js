/* Playback for a mixed queue: each song plays in its own service.
   - Spotify songs: the Web Playback SDK turns this tab into a Spotify device (desktop browsers,
     Premium). Where it can't run (phone browsers, DRM off), Mixtape remote-controls your Spotify
     app (Spotify Connect) and polls what's playing. A run of consecutive Spotify songs (up to
     BATCH) is sent at once; Mixtape moves on to the next song itself when the run ends.
   - YouTube songs: YouTube's IFrame player, in a small video window (YouTube's rules say the
     player must stay visible, at least 200×200 px). No ads if you're signed in to YouTube Premium
     in this browser. Songs whose owner turned off embedding are skipped with a message.
   The Spotify access token comes from the Worker (/spotify/token); the refresh token never leaves it. */
import { api } from './api.js';

const SP = 'https://api.spotify.com/v1/';
const BATCH = 50;
export const P = { src: null, mode: null, ready: false, deviceId: null, device: '', state: null, ctx: null, error: '', busy: false,
  vol: +(localStorage.getItem('mixtape.vol') ?? 0.7), ytBig: localStorage.getItem('mixtape.ytbig') === '1' };
let sdk = null, player = null, onChange = () => {}, tokenCache = { t: '', exp: 0 }, poll = null, ending = false;
let ytApi = null, ytp = null, ytTick = null;

export function onPlayerChange(fn) { onChange = fn; }
const emit = () => onChange();
const mobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/* ================= Spotify ================= */
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
  if (P.src !== 'spotify') return;           // a YouTube song is playing: ignore Spotify's "paused" news
  if (!s) { P.state = null; emit(); return; }
  const cur = s.track_window?.current_track;
  P.state = { id: cur ? 'sp:' + (cur.linked_from?.id || cur.id) : null, title: cur?.name || '', artists: (cur?.artists || []).map(a => a.name).join(', '),
    image: cur?.album?.images?.[0]?.url || '', paused: s.paused, pos: s.position, dur: s.duration, at: Date.now() };
  syncIndex();
  // the last song of a Spotify run finished: carry on with the next song in our own list
  const c = P.ctx;
  if (c && s.paused && s.position === 0 && !ending) {
    const lastUri = c.batch[c.batch.length - 1];
    if ((s.track_window?.previous_tracks || []).some(t => t.uri === lastUri || 'spotify:track:' + t.linked_from?.id === lastUri) && c.start + c.batch.length < c.list.length) {
      ending = true;
      playIndex(c.start + c.batch.length).catch(e => { P.error = e.message; emit(); }).finally(() => { ending = false; });
    }
  }
  media();emit();
}
function syncIndex() {
  const c = P.ctx;if (!c || !P.state?.id || P.src !== 'spotify') return;
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
  if (P.mode !== 'connect' || P.src !== 'spotify' || document.hidden) return;
  try {
    const s = await web('me/player');
    // Spotify finished the last song of our run and stopped: move on in our own list (e.g. to a YouTube song)
    const c = P.ctx, last = c?.batch[c.batch.length - 1];
    if (c && c.wasPlayingLast && s && !s.is_playing && (s.progress_ms || 0) < 1500 && c.start + c.batch.length < c.list.length) {
      c.wasPlayingLast = false;
      return playIndex(c.start + c.batch.length).catch(e => { P.error = e.message; emit(); });
    }
    if (c) c.wasPlayingLast = !!(s?.is_playing && last && 'spotify:track:' + (s.item?.linked_from?.id || s.item?.id) === last);
    if (s?.item && P.src === 'spotify') {
      P.state = { id: 'sp:' + (s.item.linked_from?.id || s.item.id), title: s.item.name, artists: (s.item.artists || []).map(a => a.name).join(', '),
        image: s.item.album?.images?.[0]?.url || '', paused: !s.is_playing, pos: s.progress_ms, dur: s.item.duration_ms, at: Date.now() };
      P.device = s.device?.name || P.device;syncIndex();media();
    }
    emit();
  } catch (e) { /* keep the last state */ }
  poll = setTimeout(pollConnect, 3000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && P.mode === 'connect' && P.src === 'spotify') pollConnect(); });

async function spotifyPause() {
  try {
    if (P.mode === 'browser') await player?.pause();
    else if (P.mode === 'connect' && P.state && !P.state.paused && P.src === 'spotify') await web('me/player/pause', 'PUT');
  } catch (e) { /* nothing was playing */ }
}

/* ================= YouTube ================= */
function loadYt() {
  if (ytApi) return ytApi;
  ytApi = new Promise((res, rej) => {
    if (window.YT?.Player) return res();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(); };
    const s = document.createElement('script');s.src = 'https://www.youtube.com/iframe_api';s.async = true;
    s.onerror = () => rej(new Error("Couldn't load YouTube's player"));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('YouTube player took too long to load')), 15000);
  });
  ytApi.catch(() => {});
  return ytApi;
}
export const preloadYt = () => loadYt();

const YT_ERR = { 2: 'bad video id', 5: "can't play in this browser", 100: 'removed or private', 101: "the owner doesn't allow playing outside YouTube", 150: "the owner doesn't allow playing outside YouTube" };
function ytBox(show) {
  const box = document.getElementById('ytbox');if (!box) return;
  box.hidden = !show;box.classList.toggle('big', P.ytBig);
  document.body.classList.toggle('yt', !!show);
}
function ytState(t) {   // refresh P.state from the YouTube player
  if (!ytp?.getCurrentTime || P.src !== 'youtube') return;
  const st = ytp.getPlayerState?.();
  P.state = { id: t?.id || P.state?.id, title: t?.title ?? P.state?.title, artists: t?.artists ?? P.state?.artists, image: t?.image ?? P.state?.image,
    paused: st !== 1 && st !== 3, pos: (ytp.getCurrentTime() || 0) * 1000, dur: (ytp.getDuration() || 0) * 1000 || (t?.dur ?? P.state?.dur ?? 0), at: Date.now() };
}
async function ytPlay(t) {
  await loadYt();
  const vid = t.id.slice(3);
  ytBox(true);
  P.src = 'youtube';P.device = 'YouTube';
  P.state = { id: t.id, title: t.title, artists: t.artists, image: t.image, paused: false, pos: 0, dur: t.dur || 0, at: Date.now() };emit();
  if (!ytp) {
    await new Promise((res, rej) => {
      ytp = new window.YT.Player('ytframe', {
        width: '100%', height: '100%', videoId: vid,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => { ytp.setVolume(Math.round(P.vol * 100)); ytp.playVideo(); res(); },
          onStateChange: e => {
            if (P.src !== 'youtube') return;
            if (e.data === 0) { next().catch(err => { P.error = err.message; emit(); }); return; }   // ended
            ytState();media();emit();
          },
          onError: e => {
            if (P.src !== 'youtube') return;
            const cur = P.ctx?.list[P.ctx.index];
            P.error = `"${cur?.title || 'This video'}" can't play here (${YT_ERR[e.data] || 'error ' + e.data}). Skipped; open it in YouTube Music instead.`;
            emit();next().catch(() => {});
          },
        },
      });
      setTimeout(() => rej(new Error("YouTube's player didn't start")), 15000);
    });
  } else ytp.loadVideoById(vid);
  clearInterval(ytTick);
  ytTick = setInterval(() => { if (P.src === 'youtube') { ytState(); emit(); } }, 1000);
}
function ytStop() { clearInterval(ytTick); try { ytp?.pauseVideo(); } catch (e) {} ytBox(false); }
export function toggleYtSize() { P.ytBig = !P.ytBig; localStorage.setItem('mixtape.ytbig', P.ytBig ? '1' : ''); ytBox(P.src === 'youtube'); }

/* ================= the queue ================= */
async function playIndex(i) {
  const c = P.ctx;if (!c || i < 0 || i >= c.list.length) return;
  const t = c.list[i];
  c.index = i;
  if (t.src === 'youtube') {
    if (P.src === 'spotify') await spotifyPause();
    clearTimeout(poll);
    return ytPlay(t);
  }
  // Spotify: send the run of consecutive Spotify songs starting here
  if (P.src === 'youtube') ytStop();
  P.src = 'spotify';
  if (!(P.ready && P.deviceId && (P.mode === 'browser' || P.mode === 'connect'))) {
    const ok = await (preloadSdk().then(() => startBrowser(), () => false));
    if (!ok) await pickDevice();
  }
  const run = [];
  for (let k = i; k < c.list.length && run.length < BATCH && c.list[k].src === 'spotify'; k++) run.push('spotify:track:' + c.list[k].id.slice(3));
  c.start = i;c.batch = run;
  P.device = P.mode === 'browser' ? 'This browser' : P.device;
  await web('me/player/play?device_id=' + encodeURIComponent(P.deviceId), 'PUT', { uris: run, offset: { position: 0 } });
  if (P.mode === 'connect') { setTimeout(pollConnect, 700); }
}

/* Start playing `tracks` (Mixtape track objects, in list order) from index i. */
export async function playList(tracks, i) {
  if (!tracks[i]) throw new Error('Nothing to play');
  P.error = '';P.busy = true;P.ctx = { list: tracks.slice(), index: i, start: i, batch: [] };emit();
  try { await playIndex(i); }
  finally { P.busy = false; emit(); }
}

export async function toggle() {
  if (!P.ctx) return;
  if (P.src === 'youtube') { const st = ytp?.getPlayerState?.(); if (st === 1 || st === 3) ytp.pauseVideo(); else ytp?.playVideo(); setTimeout(() => { ytState(); emit(); }, 150); return; }
  if (P.mode === 'browser') return player.togglePlay();
  if (P.state?.paused) await web('me/player/play?device_id=' + encodeURIComponent(P.deviceId), 'PUT');
  else await web('me/player/pause', 'PUT');
  if (P.state) P.state.paused = !P.state.paused;emit();setTimeout(pollConnect, 600);
}
export async function next() {
  const c = P.ctx;if (!c) return;
  if (c.index + 1 >= c.list.length) { if (P.src === 'youtube') { ytState(); emit(); } return; }   // end of the list
  if (P.src === 'youtube' || c.index + 1 >= c.start + c.batch.length) return playIndex(c.index + 1);
  if (P.mode === 'browser') return player.nextTrack();
  await web('me/player/next', 'POST');setTimeout(pollConnect, 600);
}
export async function prev() {
  const c = P.ctx;if (!c) return;
  if (now() > 3000) return seek(0);
  if (P.src === 'youtube' || c.index - 1 < c.start) return playIndex(Math.max(0, c.index - 1));
  if (P.mode === 'browser') return player.previousTrack();
  await web('me/player/previous', 'POST');setTimeout(pollConnect, 600);
}
export async function seek(ms) {
  if (!P.state) return;
  if (P.src === 'youtube') ytp?.seekTo(ms / 1000, true);
  else if (P.mode === 'browser') await player.seek(ms);
  else await web('me/player/seek?position_ms=' + Math.round(ms), 'PUT');
  P.state.pos = ms;P.state.at = Date.now();emit();
}
export function setVolume(v) {
  P.vol = v;localStorage.setItem('mixtape.vol', String(v));
  if (P.mode === 'browser') player?.setVolume(v);
  try { ytp?.setVolume(Math.round(v * 100)); } catch (e) {}
}
/* current position in ms (counts forward between updates while playing) */
export function now() {
  const s = P.state;if (!s) return 0;
  return Math.min(s.dur || Infinity, s.pos + (s.paused ? 0 : Date.now() - s.at));
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
