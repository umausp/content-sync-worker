// GDELT GKG 2.1 raw file — the RELIABLE FALLBACK surface. The DOC API 429s on
// shared IPs; the GKG file lives on an UNTHROTTLED Google-Storage CDN (verified
// 5/5 rapid hits, 100%). Trade-off: GKG has NO headline column — we derive a
// title from the URL slug (imperfect but serviceable), and it's the whole world's
// feed so we filter to India ourselves.
//
// GKG 2.1 is 27 tab-delimited columns (verified against a live file + codebook):
//   [1]=date(YYYYMMDDHHMMSS) [3]=domain [4]=URL [7]=V1Themes [9]=V1Locations
//   [15]=Tone(7 csv floats) [18]=SharingImage [23]=AllNames
// Host gotchas (verified): data.gdeltproject.org is HTTP-only (HTTPS → cert
// mismatch; use the storage.googleapis.com form for TLS); and the newest stamp in
// lastupdate.txt can 404 for a few minutes (GKG lands last) → read the URL from
// lastupdate.txt and tolerate 404 by trying masterfilelist's tail.

import { unzipSingle } from './unzip.mjs';
import { outletFromDomain } from './doc.mjs';

const UA = 'agyata-newsbot/1.0 (+https://agyata.com)';
// TLS-safe canonical GCS host (avoids the data.gdeltproject.org cert mismatch).
const GCS = 'https://storage.googleapis.com/data.gdeltproject.org/gdeltv2';

// India relevance for the world-wide GKG feed: Indian domain OR an India location
// (V1Locations country code = IN). Domain check is the strong signal.
const INDIA_DOMAIN =
  /(\.in\/|\.in$|indianexpress|thehindu|hindustantimes|timesofindia|ndtv|news18|indiatoday|livemint|moneycontrol|economictimes|business-standard|deccanherald|firstpost|zeenews|dnaindia|scroll\.in|thewire|theprint|aninews|ptinews|freepressjournal)/i;

async function get(url, asBuffer) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

// Resolve the newest available GKG zip URL. Prefer lastupdate.txt; if that stamp
// 404s (GKG lands last), fall back to the newest entry in masterfilelist.txt.
async function resolveGkgUrl(log) {
  const lu = await get(`${GCS}/lastupdate.txt`, false);
  const line = lu && lu.split('\n').find((l) => l.includes('.gkg.csv.zip'));
  let url = line ? line.trim().split(/\s+/).pop() : null;
  if (url) {
    url = url.replace('http://data.gdeltproject.org', 'https://storage.googleapis.com/data.gdeltproject.org');
    // HEAD-ish check via range GET (cheap) — if 404, drop to masterfile tail.
    const probe = await fetch(url, { method: 'GET', headers: { 'user-agent': UA, range: 'bytes=0-0' }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (probe && (probe.status === 200 || probe.status === 206)) return url;
    log('gdelt.gkg.lastupdate_404', { url });
  }
  const mf = await get(`${GCS}/masterfilelist.txt`, false);
  if (!mf) return null;
  const gkgLines = mf.split('\n').filter((l) => l.includes('.gkg.csv.zip'));
  const last = gkgLines[gkgLines.length - 1];
  if (!last) return null;
  return last.trim().split(/\s+/).pop().replace('http://data.gdeltproject.org', 'https://storage.googleapis.com/data.gdeltproject.org');
}

// Derive a readable-ish title from a URL slug (GKG has no headline). Takes the
// last meaningful path segment, splits on -/_, title-cases, drops date/id noise.
export function titleFromUrl(u) {
  try {
    const path = new URL(u).pathname.replace(/\/+$/, '');
    const segs = path.split('/').filter(Boolean);
    // pick the longest wordy segment (skips /2026/07/18/ date paths + numeric ids)
    let best = '';
    for (const s of segs) {
      const words = s
        .replace(/\.(html?|php|amp|cms|ece|stm)$/i, '')
        .split(/[-_.]+/)
        // keep only real words: has a letter, len>1, and NOT a mostly-digit id token
        .filter((w) => /[a-z]/i.test(w) && w.length > 1 && !/^\d+[a-z]?$/i.test(w) && (w.match(/\d/g) || []).length <= w.length / 2);
      if (words.length >= 3 && words.join(' ').length > best.length) best = words.join(' ');
    }
    if (!best) return '';
    return best.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 140);
  } catch {
    return '';
  }
}

// Fetch + parse the newest GKG file → India Article[]. Best-effort: [] on failure.
export async function fetchGkg(opts = {}) {
  const log = opts.log || (() => {});
  const max = opts.max || 250;
  try {
    const url = await resolveGkgUrl(log);
    if (!url) { log('gdelt.gkg.no_url', {}); return []; }
    const zipped = await get(url, true);
    if (!zipped) { log('gdelt.gkg.download_failed', { url }); return []; }
    const tsv = unzipSingle(zipped).toString('utf8');
    const rows = tsv.split('\n');
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row) continue;
      const c = row.split('\t');
      if (c.length < 19) continue;
      const domain = (c[3] || '').toLowerCase();
      const link = c[4] || '';
      if (!/^https?:\/\//i.test(link)) continue;
      // India relevance = INDIAN PUBLISHER domain only. A location/mention match
      // ("...IN..." in V1Locations) is too loose — it let in a UK paper merely
      // MENTIONING India (verified: swindonadvertiser.co.uk). Publisher domain is
      // the precise signal for "India-first" news.
      const isIndia = INDIA_DOMAIN.test(link) || INDIA_DOMAIN.test(domain);
      if (!isIndia) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      const title = titleFromUrl(link);
      if (title.split(' ').length < 3) continue; // unusable slug → skip
      const img = c[18] && /^https:\/\//i.test(c[18]) ? c[18] : null;
      const d = (c[1] || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
      const publishedAt = d ? `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z` : null;
      out.push({ title, url: link, sourceName: outletFromDomain(domain), snippet: title, imageUrl: img, publishedAt, category: 'top', via: 'gdelt-gkg' });
      if (out.length >= max) break;
    }
    log('gdelt.gkg.ok', { url, india: out.length });
    return out;
  } catch (e) {
    log('gdelt.gkg.error', { err: e.message });
    return [];
  }
}
