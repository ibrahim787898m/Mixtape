/* Talking to the Mixtape Worker. Its address + app key live in localStorage 'mixtape.api'
   on each device (never in the repo). */
const K = 'mixtape.api';
export const apiCfg = () => { try { return JSON.parse(localStorage.getItem(K)); } catch (e) { return null; } };
export const setApiCfg = c => c ? localStorage.setItem(K, JSON.stringify(c)) : localStorage.removeItem(K);

export async function api(path, body, cfg = apiCfg()) {
  if (!cfg?.url) throw new Error('Connect your Worker in Settings first');
  let r;
  try {
    r = await fetch(cfg.url + path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + cfg.key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { throw new Error("Can't reach the Worker (offline, wrong address, or this site isn't in ALLOWED_ORIGINS)"); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 && /app key/i.test(d.error || '') ? 'Wrong app key' : d.error || 'Worker error ' + r.status);
  return d;
}
