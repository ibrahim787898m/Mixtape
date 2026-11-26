/* Mixtape Connect: one "now playing" shared by all your devices (like Spotify Connect).
   The Worker keeps the session ({rev, queue, index, host, spOut, playing, pos, at, …}). Every open
   Mixtape polls it. The host (the device that plays) follows each new rev with the local player and
   reports its position; the others just show the session and send commands. Buttons never act on
   the local player directly: they change the session, so every device agrees. */
import { api, apiCfg } from './api.js';
import * as Player from './player.js';

const DK = 'mixtape.device', NK = 'mixtape.devname';
export const me = localStorage.getItem(DK) || (() => { const id = 'd' + crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 14); localStorage.setItem(DK, id); return id; })();
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
function autoName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
}
export const devName = () => localStorage.getItem(NK) || autoName();
export const setDevName = n => { n = String(n || '').trim().slice(0, 40); n ? localStorage.setItem(NK, n) : localStorage.removeItem(NK); Player.setDeviceName(devName()); };

export const C = { s: null, devices: [], offset: 0, applied: 0, err: '', last: 0 };
let resolve = () => null, onChange = () => {}, pollT = null, reportT = null, busy = false, lastQueueKey = '';
const emit = () => onChange();
const serverNow = () => Date.now() + C.offset;
export const isHost = () => !!C.s && C.s.host === me;
const STALE = 20e3;
export const hostOffline = () => !!C.s && C.s.playing && C.s.host !== me && serverNow() - (C.s.hostSeen || 0) > STALE;

let started = false;
export function init(opts) {
  resolve = opts.resolve;onChange = opts.onChange || onChange;
  if (started) { poll(); return; }
  started = true;
  Player.setDeviceName(devName());
  Player.onPlayerChange(localChanged);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setMedia();
  poll();
}

/* ---------- talking to the Worker ---------- */
function take(r) {
  if (r.now) C.offset = r.now - Date.now();
  if (r.devices) C.devices = r.devices;
  if (r.session !== undefined) C.s = r.session;
  C.last = Date.now();
}
async function poll() {
  clearTimeout(pollT);
  if (!apiCfg()) return;
  try {
    take(await api(`/session?d=${encodeURIComponent(me)}&n=${encodeURIComponent(devName())}&m=${isMobile ? 1 : 0}`));
    C.err = '';await follow();
  } catch (e) { C.err = e.message; }
  emit();
  pollT = setTimeout(poll, isHost() || !document.hidden ? 2500 : 15000);
}
async function op(body) {
  const r = await api('/session', { d: me, ...body });
  take(r);await follow();emit();
  return r;
}

/* ---------- the host follows the session ---------- */
const tracksOf = q => q.map(id => resolve(id)).filter(Boolean);
async function follow() {
  const s = C.s;
  if (!s || s.host !== me) {                 // someone else plays: stop here if we were playing
    if (Player.P.ctx && Player.P.state && !Player.P.state.paused) await Player.pauseAll();
    stopReports();
    return;
  }
  if (s.rev === C.applied || busy) return;
  busy = true;
  try {
    const key = s.queue.length + ':' + s.queue[0] + ':' + s.queue[s.queue.length - 1];
    const list = tracksOf(s.queue);
    const newQueue = !Player.P.ctx || key !== lastQueueKey;
    if (newQueue) { Player.load(list); lastQueueKey = key; }
    Player.setSpotifyOut(s.spOut || null);
    const want = Math.min(s.index, list.length - 1), local = Player.P.ctx.index;
    const target = serverNow() - s.at, pos = s.playing ? s.pos + Math.max(0, target) : s.pos;
    // start the song fresh unless exactly this song is already the one playing here
    const freshStart = newQueue || !Player.P.state || local !== want || Player.P.state.id !== list[want]?.id || Player.P.outChanged;
    if (freshStart) { await Player.playIndex(want); if (pos > 2500) await Player.seek(pos); if (!s.playing) await Player.pauseAll(); }
    else {
      if (s.playing && Player.P.state?.paused) await Player.resume();
      if (!s.playing && !Player.P.state?.paused) await Player.pauseAll();
      if (Math.abs(Player.now() - pos) > 3500) await Player.seek(pos);
    }
    C.applied = s.rev;
    startReports();
  } catch (e) { C.err = e.message; Player.P.error = e.message; }
  finally { busy = false; }
}

/* the host tells the others where it really is (every 5 s, and right away when something changes) */
function startReports() { if (!reportT) reportT = setInterval(report, 5000); }
function stopReports() { clearInterval(reportT); reportT = null; }
let lastSent = '';
async function report(force) {
  if (!isHost() || !Player.P.ctx || busy) return;
  const st = Player.P.state, sp = Player.P.src === 'spotify';
  const body = { op: 'report', rev: C.s.rev, index: Player.P.ctx.index, pos: Math.round(Player.now()), dur: st?.dur || 0, playing: !!st && !st.paused,
    spDev: sp ? Player.P.deviceId : null, spOutName: sp && Player.P.mode === 'connect' ? Player.P.device : '' };
  const sig = body.index + ':' + body.playing;
  if (!force && sig === lastSent && !body.playing) return;
  lastSent = sig;
  try { const r = await api('/session', { d: me, ...body }); take(r); if (r.session?.rev !== C.applied && r.session?.host === me && r.session.index === Player.P.ctx.index) C.applied = r.session.rev; emit(); } catch (e) { /* next time */ }
}
function localChanged() {            // the local player moved on by itself (song ended, run ended)
  if (isHost() && Player.P.ctx && C.s && !busy) {
    const sig = Player.P.ctx.index + ':' + !!(Player.P.state && !Player.P.state.paused);
    if (Player.P.ctx.index !== C.s.index || sig !== lastSent) report(true);
  }
  emit();
}

/* ---------- commands (any device) ---------- */
// a device that's gone quiet (phone locked, tab closed) can't follow commands: take over first
async function viaHost(body) {
  if (hostOffline()) await op({ op: 'transfer', host: me, spOut: C.s.spDev && view().src === 'spotify' ? C.s.spDev : null });
  return op(body);
}
export async function play(tracks, i) {
  const list = tracks.filter(Boolean);
  const queue = list.map(t => t.id), k = Math.max(0, list.indexOf(tracks[i]));
  // keep playing where it plays now, if that device is still around; otherwise here
  const host = C.s && !hostOffline() && C.devices.some(d => d.id === C.s.host) ? C.s.host : me;
  Player.primeFromClick();                   // let this tab make sound (browsers need a click)
  return op({ op: 'start', queue, index: k, host, spOut: host === C.s?.host ? C.s?.spOut ?? null : null });
}
export const toggle = () => C.s && viaHost({ op: 'toggle' });
export const next = () => C.s && viaHost({ op: 'next' });
export const prev = () => C.s && viaHost({ op: 'prev' });
export const seek = pos => C.s && viaHost({ op: 'seek', pos: Math.round(pos) });
export const jump = i => C.s && viaHost({ op: 'jump', index: i });
export function transfer(target) {        // target: {mixtape: deviceId} or {spotify: deviceId}
  if (!C.s) return;
  Player.primeFromClick();
  return target.spotify ? op({ op: 'transfer', host: me, spOut: target.spotify }) : op({ op: 'transfer', host: target.mixtape, spOut: null });
}
export const refresh = () => poll();

/* ---------- what the player bar shows ---------- */
export function view() {
  const s = C.s;if (!s) return null;
  if (isHost() && Player.P.state) {
    const ps = Player.P.state, t = resolve(ps.id) || resolve(s.queue[s.index]);
    return { host: true, t, title: ps.title || t?.title, artists: ps.artists || t?.artists, image: t?.image || ps.image, paused: ps.paused, pos: Player.now(), dur: ps.dur || t?.dur || 0,
      src: Player.P.src, where: Player.P.src === 'youtube' ? 'YouTube on this device' : (Player.P.mode === 'browser' ? 'This device' : Player.P.device || 'Spotify'), busy: Player.P.busy };
  }
  const t = resolve(s.queue[s.index]);
  const hostDev = C.devices.find(d => d.id === s.host), off = hostOffline();
  const pos = s.playing && !off ? Math.min(s.dur || t?.dur || Infinity, s.pos + (serverNow() - s.at)) : s.pos;
  return { host: s.host === me, t, title: t?.title || '…', artists: t?.artists || '', image: t?.image, paused: !s.playing || off, pos, dur: s.dur || t?.dur || 0,
    src: t?.src, where: (hostDev?.name || 'another device') + (s.spOutName ? ' · ' + s.spOutName : '') + (off ? ' (offline)' : ''), offline: off, busy: false };
}

/* lock-screen / media keys go through the session too */
function setMedia() {
  if (!('mediaSession' in navigator)) return;
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, () => f()?.catch?.(() => {})); } catch (e) {} };
  h('play', toggle);h('pause', toggle);h('nexttrack', next);h('previoustrack', prev);
}
