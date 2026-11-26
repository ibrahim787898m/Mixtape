/* Spotify sign-in (Authorization Code with PKCE, no client secret). The browser signs in and
   hands the refresh token to the Worker, which does all the syncing from then on.
   Redirect URI = this page's address (register it in the Spotify app: https://… for the live
   site, http://127.0.0.1:PORT/ for local testing; Spotify doesn't allow "localhost"). */
export const SCOPES = [
  'playlist-read-private', 'playlist-read-collaborative', 'user-library-read',   // step 1: read the library
  'playlist-modify-private', 'playlist-modify-public', 'user-library-modify',     // later: add missing songs
  'streaming', 'user-read-email', 'user-read-private',                            // later: play in the app (Premium)
  'user-read-playback-state', 'user-modify-playback-state',
].join(' ');

export const redirectUri = () => location.origin + location.pathname;
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function spotifyLogin(clientId) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('mixtape.pkce', JSON.stringify({ verifier, state, clientId }));
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: SCOPES, redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, state });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

/* Back from Spotify (?code=…&state=…): swap the code for tokens. Returns the refresh token, or
   null if this page load isn't a sign-in return. Cleans the address bar either way. */
export async function spotifyReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  const saved = JSON.parse(sessionStorage.getItem('mixtape.pkce') || 'null');
  sessionStorage.removeItem('mixtape.pkce');
  if (q.get('error')) throw new Error(q.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled' : 'Spotify: ' + q.get('error'));
  if (!saved || saved.state !== q.get('state')) throw new Error('Spotify sign-in expired or came from elsewhere. Try again.');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(),
      client_id: saved.clientId, code_verifier: saved.verifier }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.refresh_token) throw new Error('Spotify sign-in failed: ' + (t.error_description || t.error || r.status));
  return t.refresh_token;
}
