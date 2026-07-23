// get_token.mjs — ONE-TIME OAuth: mint a YouTube refresh token for a channel.
//
// Run LOCALLY (not in CI — this step needs a browser + your click; that's OAuth by
// design, and it's the only manual step). After this, the pipeline uses the printed
// refresh token + client id/secret to auto-mint access tokens forever, no human.
//
//   YT_CLIENT_ID=... YT_CLIENT_SECRET=... node shorts/get_token.mjs
//
// Steps it runs for you:
//   1. starts a localhost callback server on http://localhost:8719
//   2. prints a Google consent URL — open it, pick the CHANNEL's Google account,
//      click Allow (scope: youtube — upload AND playlist management)
//   3. captures the ?code, exchanges it for tokens, PRINTS the refresh_token
//   4. paste that into the GitHub secret: YT_REFRESH_TOKEN_WORLD (or _BHARAT)
//
// PREREQ in Google Cloud console → APIs & Services → Credentials → your OAuth client
// (type: Web application): add  http://localhost:8719  to "Authorized redirect URIs".

import { createServer } from 'node:http';

const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REDIRECT = process.env.YT_REDIRECT || 'http://localhost:8719';
const PORT = Number(new URL(REDIRECT).port || 8719);
// `youtube` (not just youtube.upload) so the SAME token can BOTH upload a video AND add it
// to a playlist (playlistItems.insert needs the broader scope). Upload-only tokens make the
// playlist add 403 — the reason World's USA/Europe playlist adds were silently skipping.
const SCOPE = 'https://www.googleapis.com/auth/youtube';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set YT_CLIENT_ID and YT_CLIENT_SECRET env vars first.');
  process.exit(2);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // ← required to get a refresh_token
    prompt: 'consent', // ← force a refresh_token even on re-auth
  }).toString();

async function exchange(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

console.log('\n1) Make sure this redirect URI is registered on your OAuth client:');
console.log(`     ${REDIRECT}`);
console.log('\n2) Open this URL, choose the CHANNEL account, click Allow:\n');
console.log(`   ${authUrl}\n`);

const server = createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err) {
    res.end(`Auth error: ${err}. You can close this tab.`);
    console.error(`\nAuth denied: ${err}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.statusCode = 400;
    res.end('No code.');
    return;
  }
  try {
    const tok = await exchange(code);
    res.end('✅ Done — refresh token captured. You can close this tab and return to the terminal.');
    console.log('\n────────────────────────────────────────────────────────');
    if (tok.refresh_token) {
      console.log('REFRESH TOKEN (paste into the GitHub secret):\n');
      console.log(`   ${tok.refresh_token}\n`);
      console.log('Secret name: YT_REFRESH_TOKEN_WORLD  (or YT_REFRESH_TOKEN_BHARAT for the Hindi channel)');
    } else {
      console.log('No refresh_token returned. Re-run — if the account was already');
      console.log('authorized, revoke access at https://myaccount.google.com/permissions');
      console.log('then run again (prompt=consent + access_type=offline are already set).');
    }
    console.log('────────────────────────────────────────────────────────\n');
  } catch (e) {
    res.end(`Exchange failed: ${e.message}`);
    console.error(`\n${e.message}`);
  } finally {
    server.close();
    process.exit(0);
  }
});
server.listen(PORT, () => console.log(`(listening on ${REDIRECT} for the callback…)`));
