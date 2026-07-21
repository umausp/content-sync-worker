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
export async function buildChrome(story, cfg, outDir) {
  await mkdir(outDir, { recursive: true });
  const W = VIDEO.width;
  const H = VIDEO.height;
  const badge = story.isBreaking ? 'BREAKING' : story.isLive ? 'LIVE' : (story.category || 'NEWS').toUpperCase();
  const badgeColor = story.isBreaking || story.isLive ? BRAND.breaking : BRAND.accent;
  const chip = `#${esc(story.hashtag || 'news')}`;
  const source = story.sourceName ? `Source: ${esc(story.sourceName)}` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <!-- bottom scrim so captions/CTA stay legible over any photo -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>
    <!-- top brand bar -->
    ${brandMark(48, 60, 96)}
    <text x="164" y="128" font-family="${cfg.font}" font-size="46" font-weight="900" fill="${BRAND.text}">Agyata</text>
    <!-- badge chip -->
    <rect x="${W - 340}" y="66" width="292" height="72" rx="36" fill="${badgeColor}"/>
    <text x="${W - 194}" y="115" font-family="${cfg.font}" font-size="38" font-weight="900" fill="#fff" text-anchor="middle">${esc(badge)}</text>
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
  const maxChars = isDeva ? 18 : 20;
  const fontSize = isDeva ? 60 : 64;
  const lineH = fontSize * 1.24;
  const lines = wrap(text, maxChars).slice(0, 4);
  // Vertically place the caption block centered in the lower-middle third.
  const blockH = lines.length * lineH;
  const startY = H * 0.60 - blockH / 2 + fontSize;
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
