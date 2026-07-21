// upload.mjs — publish a staged Short to YouTube via Data API v3 videos.insert.
//
//   node scripts/shorts/upload.mjs <world|bharat> <stampDir>
//
// Reads docs/youtube/shorts/<channel>/<stamp>/{short.mp4,meta.json}, exchanges the
// channel's OAuth REFRESH token for an access token (headless — no browser in CI),
// then does a resumable upload with the meta (title/description/tags/category), sets
// the AI-disclosure flag, and uploads PRIVATE by default (human flips to public, and
// unverified API projects are forced private until audited anyway).
//
// Secrets (repo/Actions):
//   YT_CLIENT_ID, YT_CLIENT_SECRET        — one OAuth client (Desktop type)
//   YT_REFRESH_TOKEN_WORLD / _BHARAT      — per-channel refresh token
// Get a refresh token once via the OAuth consent flow with scope
//   https://www.googleapis.com/auth/youtube.upload  (offline access).
//
// videos.insert = 1 quota unit, 100/day (2025 quota model) — volume is a non-issue.

import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { STAGE_DIR, channel } from './config.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

async function accessToken(refreshToken) {
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('YT_CLIENT_ID / YT_CLIENT_SECRET not set');
  if (!refreshToken) throw new Error('channel refresh token not set');
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('no access_token in token response');
  return j.access_token;
}

function snippetStatus(meta) {
  const snippet = {
    title: String(meta.title || 'Agyata News').slice(0, 100),
    description: String(meta.description || '').slice(0, 4900),
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 30) : [],
    categoryId: String(meta.categoryId || '25'),
  };
  const status = {
    privacyStatus: meta.privacyStatus || 'private',
    selfDeclaredMadeForKids: !!meta.selfDeclaredMadeForKids,
    // AI-disclosure: declare synthetic/altered media (Kokoro narration). Cost-free,
    // policy-safe; YouTube shows the label but it does NOT limit reach/monetization.
    containsSyntheticMedia: meta.containsSyntheticMedia !== false,
  };
  return { snippet, status };
}

// Resumable upload: (1) POST metadata → get upload URL, (2) PUT the bytes.
async function resumableUpload(token, mp4Path, meta) {
  const bytes = await readFile(mp4Path);
  const metaBody = JSON.stringify(snippetStatus(meta));
  const init = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(bytes.length),
    },
    body: metaBody,
  });
  if (!init.ok) throw new Error(`insert init ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const location = init.headers.get('location');
  if (!location) throw new Error('no resumable upload URL returned');

  const put = await fetch(location, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4', 'content-length': String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload PUT ${put.status}: ${(await put.text()).slice(0, 300)}`);
  return put.json();
}

async function main() {
  const channelId = process.argv[2];
  const stamp = process.argv[3];
  if (!channelId || !stamp) {
    console.error('usage: node scripts/shorts/upload.mjs <world|bharat> <stamp>');
    process.exit(2);
  }
  const cfg = channel(channelId);
  const dir = join(STAGE_DIR, cfg.id, stamp);
  const mp4 = join(dir, 'short.mp4');
  const metaPath = join(dir, 'meta.json');
  await stat(mp4); // throws if missing
  const meta = JSON.parse(await readFile(metaPath, 'utf-8'));

  const refresh = process.env[cfg.uploadSecret];
  console.log(`[upload:${cfg.id}] authenticating (${cfg.uploadSecret})…`);
  const token = await accessToken(refresh);
  console.log(`[upload:${cfg.id}] uploading ${basename(mp4)} — "${meta.title}"`);
  const res = await resumableUpload(token, mp4, meta);
  const id = res?.id;
  if (!id) throw new Error(`upload returned no video id: ${JSON.stringify(res).slice(0, 200)}`);
  console.log(`[upload:${cfg.id}] ✓ https://youtube.com/watch?v=${id} (privacy=${meta.privacyStatus || 'private'})`);
}

main().catch((e) => {
  console.error(`[upload] FAILED: ${e.message}`);
  process.exit(1);
});
