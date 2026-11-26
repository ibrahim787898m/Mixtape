/* Matching the same song across Spotify and YouTube Music.
   YouTube has no ISRC, so a YouTube song matches a Spotify one when:
     - the cleaned-up titles are equal ("(Official Video)", "[Lyrics]", "feat. …", "- Remastered 2011",
       punctuation and accents removed; works for any script, e.g. Hindi/Urdu),
     - an artist matches (a Spotify artist appears in the YouTube artist or title, or the other way round),
     - and the lengths are within 25 s (music videos often have a short intro; longer = a different cut).
   Strict on purpose: playing the wrong song is worse than playing a video. */

const NOISE = /\s*[([](?:[^)\]]*?\b(?:official|video|audio|lyrics?|lyric|visuali[sz]er|remaster(?:ed)?|mv|hd|4k|live|version|explicit|clean|radio edit|feat\.?|ft\.?|with|prod\.?)\b[^)\]]*)[)\]]/gi;
const DASHTAIL = /\s+[-–—]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|live|radio edit|single version|mono|stereo)\b.*$/i;
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
const strip = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = s => strip(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function normTitle(t) { return words(String(t || '').split(/\s+[|｜]\s+/)[0].replace(NOISE, '').replace(DASHTAIL, '').replace(FEAT, '')); }   // "Song (Full Video) | Film | Singer" → "song"
export const normArtist = a => words(String(a || '').replace(/^the\s+/i, ''));
const artistsOf = t => String(t.artists || '').split(/\s*,\s*|\s+&\s+|\s+x\s+/i).map(normArtist).filter(Boolean);

/* tracks: Map id → track. Sets t.alt on both sides of every match; returns the number of matches. */
export function matchTracks(tracks) {
  const byTitle = new Map();
  for (const t of tracks.values()) {
    t.alt = null;
    if (t.src !== 'spotify') continue;
    const k = normTitle(t.title);if (!k) continue;
    (byTitle.get(k) || byTitle.set(k, []).get(k)).push(t);
  }
  let n = 0;
  for (const y of tracks.values()) {
    if (y.src !== 'youtube') continue;
    const cands = byTitle.get(normTitle(y.title));if (!cands) continue;
    const yArt = normArtist(y.artists), yAll = words(y.artists + ' ' + y.title);
    const ok = cands.filter(sp => {
      const sArt = artistsOf(sp);
      const artistOk = sArt.some(a => a && (yAll.includes(a) || (yArt && a.includes(yArt))));
      const durOk = !y.dur || !sp.dur || Math.abs(y.dur - sp.dur) <= 25000;
      return artistOk && durOk;
    });
    if (!ok.length) continue;
    const best = ok.sort((a, b) => Math.abs((a.dur || 0) - (y.dur || 0)) - Math.abs((b.dur || 0) - (y.dur || 0)))[0];
    y.alt = best;best.alt ||= y;n++;         // several YouTube copies can point at one Spotify song
  }
  return n;
}
