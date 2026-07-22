// frames.mjs — build the visual layers for a Short as SVG → PNG (via rsvg-convert).
//
// This ffmpeg build has NO drawtext/libass, so ALL text is rendered here as SVG then
// rasterized to transparent PNG overlays that ffmpeg composites over the Ken-Burns
// image layer. SVG gives full brand-font + Devanagari control (rsvg + fontconfig),
// reusing the same rasterizer the social-card generator already relies on.
//
// We produce TWO kinds of overlay:
//   • chrome.png    — static: top brand bar, category/hashtag chip, source credit,
//                     bottom CTA + safe-area gradient. Composited for the whole video.
//   • cap-NN.png    — one per caption segment: the animated-in caption text block,
//                     shown only during [start,end] (ffmpeg enable='between(t,...)').
//
// All text is escaped + word-wrapped in-code (SVG has no auto-wrap).

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BRAND, VIDEO } from './config.mjs';

const execFileP = promisify(execFile);

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Greedy word-wrap to a max chars-per-line budget (SVG has no wrapping). Devanagari
// counts by code points; budget is chosen by the caller for the font size.
function wrap(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if ([...cand].length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cand;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function rasterize(svg, outPng) {
  await writeFile(`${outPng}.svg`, svg);
  // rsvg-convert: SVG → PNG at exact canvas size, preserving alpha.
  await execFileP('rsvg-convert', [
    '-w', String(VIDEO.width),
    '-h', String(VIDEO.height),
    '-o', outPng,
    `${outPng}.svg`,
  ]);
  return outPng;
}

// Shared <defs> — brand gradients + a soft shadow for legible text over photos.
function defs() {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BRAND.bgTop}"/>
      <stop offset="1" stop-color="${BRAND.bgBottom}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.accent}"/>
      <stop offset="1" stop-color="${BRAND.accent2}"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#000000" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.86"/>
    </linearGradient>
    <filter id="ds" x="-10%" y="-10%" width="120%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>`;
}

// The Agyata "A" brand mark (matches channel_logo.svg), sized `s`, at (x,y).
function brandMark(x, y, s) {
  const u = s / 320;
  return `<g transform="translate(${x},${y}) scale(${u})">
    <rect width="320" height="320" rx="72" fill="url(#accent)"/>
    <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 115 226 L 160 98 L 205 226" stroke-width="29"/>
      <path d="M 137 184 L 183 184" stroke-width="26"/>
    </g>
    <circle cx="226" cy="108" r="12" fill="#fff"/>
  </g>`;
}

// STATIC chrome overlay: top brand + badge/category chip, bottom scrim + CTA + source.
// `story.headline` (optional): a PERSISTENT on-screen title shown under the brand bar for
// the whole clip. Set for single-story Shorts + long-form so the viewer SEES the headline
// while the narration speaks only the brief (no spoken "title then description" repeat).
export async function buildChrome(story, cfg, outDir) {
  await mkdir(outDir, { recursive: true });
  const W = VIDEO.width;
  const H = VIDEO.height;
  // Prefer the caller-set badge (bharat sets a Hindi label like 'राजनीति'/'ब्रेकिंग';
  // world/hook/outro set an explicit label) so the Hindi channel never shows an English
  // chip. Fall back to breaking/live/category for the world channel's slot keys.
  const badge = story.badge
    ? String(story.badge).toUpperCase()
    : story.isBreaking
      ? 'BREAKING'
      : story.isLive
        ? 'LIVE'
        : (story.category || 'NEWS').toUpperCase();
  const badgeColor = story.isBreaking || story.isLive ? BRAND.breaking : BRAND.accent;
  const chip = `#${esc(story.hashtag || 'news')}`;
  const source = story.sourceName ? `Source: ${esc(story.sourceName)}` : '';

  // PERSISTENT HEADLINE — shown top-left under the brand bar so the viewer reads the
  // story title throughout while narration speaks only the brief. Wrapped to the canvas
  // width; a heavy top scrim behind it keeps it legible over any photo. Off for the
  // hook/outro cards (they pass no headline) and the roundup (title is spoken there).
  const land = VIDEO.landscape;
  let headlineSvg = '';
  if (story.headline) {
    const hlFont = land ? 44 : 52;
    const hlChars = land ? 46 : 26;
    const hlLines = wrap(String(story.headline), hlChars).slice(0, 3);
    const hlLineH = hlFont * 1.16;
    const hlTop = 190; // just below the brand bar / badge chip
    const bandH = hlLines.length * hlLineH + 36;
    const tspans = hlLines
      .map((ln, i) => `<tspan x="60" y="${Math.round(hlTop + 8 + (i + 1) * hlLineH)}">${esc(ln)}</tspan>`)
      .join('');
    headlineSvg = `
    <rect x="0" y="${hlTop}" width="${W}" height="${Math.round(bandH)}" fill="#000000" opacity="0.42"/>
    <text font-family="${cfg.font}" font-size="${hlFont}" font-weight="900" fill="${BRAND.text}"
          filter="url(#ds)" style="paint-order:stroke">${tspans}</text>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <!-- bottom scrim so captions/CTA stay legible over any photo -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>
    <!-- top brand bar -->
    ${brandMark(48, 60, 96)}
    <text x="164" y="128" font-family="${cfg.font}" font-size="42" font-weight="900" fill="${BRAND.text}">Agyata News</text>
    <!-- badge chip -->
    <rect x="${W - 340}" y="66" width="292" height="72" rx="36" fill="${badgeColor}"/>
    <text x="${W - 194}" y="115" font-family="${cfg.font}" font-size="38" font-weight="900" fill="#fff" text-anchor="middle">${esc(badge)}</text>
    <!-- persistent headline (single/long-form only) -->
    ${headlineSvg}
    <!-- source credit (bottom, above CTA) -->
    ${source ? `<text x="60" y="${H - 190}" font-family="${cfg.font}" font-size="30" fill="${BRAND.muted}">${source}</text>` : ''}
    <!-- hashtag chip + CTA -->
    <text x="60" y="${H - 128}" font-family="${cfg.font}" font-size="34" font-weight="700" fill="${BRAND.accent}">${esc(chip)}</text>
    <text x="60" y="${H - 66}" font-family="${cfg.font}" font-size="40" font-weight="900" fill="${BRAND.text}">${esc(cfg.ctaLine)}</text>
  </svg>`;
  return rasterize(svg, join(outDir, 'chrome.png'));
}

// One CAPTION overlay per segment. Big, centered-lower, bold, drop-shadowed — the
// "watchable" synced-caption look. `idx` names the file; caller maps it to [start,end].
export async function buildCaption(text, idx, cfg, outDir) {
  const W = VIDEO.width;
  const H = VIDEO.height;
  // Devanagari glyphs are wider — smaller per-line budget for Hindi. Arial Black is
  // heavy, so keep the Latin budget tight enough to stay inside the 1080px width with
  // the 60px side margins (measured: ~20 caps fit before the right edge clips).
  const isDeva = cfg.scriptLang === 'hi';
  const land = VIDEO.landscape;
  // AUTO-FIT: never truncate the caption (user: "does not write full text"). Start at
  // the ideal font size, and if the text needs more than maxLines, step the font DOWN
  // (which widens chars-per-line) until it fits — so the FULL sentence always shows.
  const baseFont = land ? (isDeva ? 52 : 56) : isDeva ? 60 : 64;
  const baseChars = land ? (isDeva ? 34 : 40) : isDeva ? 18 : 20;
  const maxLines = 4;
  let fontSize = baseFont;
  let lines = wrap(text, baseChars);
  while (lines.length > maxLines && fontSize > baseFont * 0.62) {
    fontSize -= 4;
    // chars-per-line scales inversely with font size.
    const chars = Math.round(baseChars * (baseFont / fontSize));
    lines = wrap(text, chars);
  }
  // Safety: if still over (extremely long), keep all lines but they'll be small.
  const lineH = fontSize * 1.24;
  // Captions sit in the BOTTOM band, just above the source/hashtag/CTA chrome (user:
  // "all captions at the bottom"). Bottom-align so 1..N-line captions hug the bottom.
  const blockH = lines.length * lineH;
  const bottomBaseline = land ? H - 150 : H - 260; // above the source/CTA lines
  const startY = bottomBaseline - blockH + fontSize;
  const tspans = lines
    .map((ln, i) => `<tspan x="${W / 2}" y="${Math.round(startY + i * lineH)}">${esc(ln)}</tspan>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <text font-family="${cfg.font}" font-size="${fontSize}" font-weight="900" fill="${BRAND.text}"
          text-anchor="middle" filter="url(#ds)" style="paint-order:stroke">${tspans}</text>
  </svg>`;
  return rasterize(svg, join(outDir, `cap-${String(idx).padStart(2, '0')}.png`));
}

// KARAOKE captions — the retention-driving style for US/UK Shorts (word-by-word, 3-4
// words on screen, one word highlighted). Splits a spoken segment's text into small
// word-groups, times each group evenly across the segment's [start,end] audio window,
// and renders one PNG per group with the "active" word highlighted brand-yellow.
// Returns [{ png, start, end }] the caller overlays with enable='between(t,...)'.
const KARAOKE_HIGHLIGHT = '#ffd400'; // yellow-on-white — the top-performing combo
export async function buildKaraokeCaptions(text, segStart, segEnd, idx, cfg, outDir) {
  const W = VIDEO.width;
  const H = VIDEO.height;
  const isDeva = cfg.scriptLang === 'hi';
  const land = VIDEO.landscape;
  const perGroup = isDeva ? 4 : 3; // words visible at once
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  // Build word-groups.
  const groups = [];
  for (let i = 0; i < words.length; i += perGroup) groups.push(words.slice(i, i + perGroup));

  // WIDTH-FIT (the fix for captions clipping horizontally, e.g. "January, Prime
  // Minister" ran edge-to-edge). Arial Black at font size F is ~0.62·F per char wide.
  // Find the widest group and pick the largest font that keeps it within the safe
  // width (frame minus generous side margins), capped at an ideal size.
  const SIDE_MARGIN = land ? 120 : 90;
  const safeW = W - 2 * SIDE_MARGIN;
  const idealFont = land ? (isDeva ? 62 : 66) : isDeva ? 64 : 72;
  const CHAR_W = isDeva ? 0.72 : 0.62; // width-per-char as a fraction of font size
  const widestChars = Math.max(...groups.map((g) => g.join(' ').length), 1);
  const fitFont = Math.floor(safeW / (widestChars * CHAR_W));
  const fontSize = Math.max(land ? 40 : 46, Math.min(idealFont, fitFont));
  // Distribute the segment duration across groups, weighted by group char-length so a
  // longer group stays on screen a touch longer (feels naturally synced).
  const dur = Math.max(0.4, segEnd - segStart);
  const weights = groups.map((g) => g.join(' ').length);
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  let t = segStart;
  const cy = land ? H * 0.68 : H * 0.62; // vertical centre of the caption band
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const gEnd = gi === groups.length - 1 ? segEnd : t + (dur * weights[gi]) / wSum;
    // Highlight one word per short beat within the group so it reads as karaoke; for a
    // 3-word group we just highlight the middle/rolling word — approximate but lively.
    const activeWord = Math.min(g.length - 1, Math.floor(g.length / 2));
    // Real spaces between words: SVG collapses whitespace between adjacent tspans, so we
    // emit an explicit space tspan between words (a leading space inside a tspan is
    // dropped). This fixes 'ministerbriefscabinet' → 'minister briefs cabinet'.
    const tspans = g
      .map(
        (w, wi) =>
          `${wi ? '<tspan> </tspan>' : ''}<tspan fill="${wi === activeWord ? KARAOKE_HIGHLIGHT : BRAND.text}">${esc(w)}</tspan>`,
      )
      .join('');
    // LEGIBILITY BAND: a rounded, semi-transparent dark pill behind the words so the
    // caption stays crisp over bright photos (sky, white shirts) — the drop shadow alone
    // washes out. Sized from the estimated text width; centered on the caption baseline.
    const textW = Math.min(safeW, g.join(' ').length * fontSize * CHAR_W);
    const padX = Math.round(fontSize * 0.5);
    const padY = Math.round(fontSize * 0.28);
    const bandW = Math.round(textW + padX * 2);
    const bandH = Math.round(fontSize + padY * 2);
    const bandX = Math.round(W / 2 - bandW / 2);
    const bandY = Math.round(cy - fontSize * 0.82 - padY);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${defs()}
      <rect x="${bandX}" y="${bandY}" width="${bandW}" height="${bandH}" rx="${Math.round(bandH * 0.28)}"
            fill="#000000" fill-opacity="0.42"/>
      <text x="${W / 2}" y="${Math.round(cy)}" font-family="${cfg.font}" font-size="${fontSize}"
            font-weight="900" text-anchor="middle" filter="url(#ds)" xml:space="preserve"
            style="paint-order:stroke">${tspans}</text>
    </svg>`;
    const png = await rasterize(svg, join(outDir, `kcap-${idx}-${String(gi).padStart(2, '0')}.png`));
    out.push({ png, start: t, end: gEnd });
    t = gEnd;
  }
  return out;
}
