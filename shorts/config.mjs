// config.mjs — per-channel configuration for the Agyata Shorts pipeline.
//
// Two channels, one engine (see docs/youtube/SHORTS_PIPELINE_DESIGN.md):
//   • world  — ENGLISH, US/UK/global audience → tier-1 CPM (the earnings engine)
//   • bharat — HINDI/HINGLISH, India audience → reach + app funnel (the growth engine)
//
// Everything tunable via env so the GitHub Actions workflow can override per run.

import { join } from 'node:path';

export const ROOT = process.cwd();
// The Python (venv) that has Kokoro installed. Actions installs it; locally it's the
// 3.12 venv we built. Override with SHORTS_PY.
export const PY = process.env.SHORTS_PY || '/tmp/kdenv/bin/python';

// Canvas orientation. Default = vertical Shorts (1080×1920). Set SHORTS_ORIENTATION=
// landscape for the LONG-FORM 16:9 build (1920×1080) — the higher-RPM monetization
// format. All render/frame/visual modules read VIDEO, so one switch flips everything.
const LANDSCAPE = process.env.SHORTS_ORIENTATION === 'landscape';
export const VIDEO = {
  width: LANDSCAPE ? 1920 : 1080,
  height: LANDSCAPE ? 1080 : 1920,
  fps: 30,
  landscape: LANDSCAPE,
  // Loudness target for YouTube (~-14 LUFS integrated).
  lufs: -14,
};

// Brand (matches docs/youtube/channel_logo.svg — purple gradient + geometric A).
export const BRAND = {
  bgTop: '#0a0a0a',
  bgBottom: '#1a1030',
  accent: '#8b5cf6',
  accent2: '#5b21b6',
  breaking: '#ef4444',
  live: '#ef4444',
  text: '#ffffff',
  muted: '#c4b5fd',
  site: 'agyata.com',
};

// Fonts on the runner/mac. Latin bold for English; Kohinoor/Noto Devanagari for Hindi.
// SVG uses font-family names; rsvg resolves via fontconfig. We ship family fallbacks.
export const FONTS = {
  latin: "'Arial Black','Arial',sans-serif",
  // Devanagari-capable stack. Actions (Ubuntu) has Noto; mac has Kohinoor.
  deva: "'Kohinoor Devanagari','Noto Sans Devanagari','Nirmala UI','Arial Unicode MS',sans-serif",
};

export const CHANNELS = {
  world: {
    id: 'world',
    label: 'Agyata World',
    lang: 'a', // Kokoro English
    // USA audio style (user ask): American-accent Kokoro voice + espeak en-us
    // phonemization. am_michael = authoritative American male news read.
    voice: process.env.SHORTS_VOICE_WORLD || 'am_michael',
    espeakLang: 'en-us',
    scriptLang: 'en',
    font: FONTS.latin,
    // Feed selection: global-interest English stories (world/business/science/tech lead).
    apiMode: 'latest',
    categoryPriority: ['world', 'business', 'science', 'tech', 'top', 'politics'],
    // Tier-1 audience fit: lead with globally-relevant desks. Exclude India-local +
    // entertainment (regional-interest) so the English channel doesn't open on a story
    // a US/UK viewer won't recognise. `sports` kept out too (very region-specific).
    categoryFit: (s) => ['world', 'business', 'science', 'tech', 'top', 'politics'].includes(s.category),
    ctaLine: 'Full story → agyata.com',
    subCta: 'Subscribe for world news',
    hashtags: ['#shorts', '#news', '#worldnews', '#breaking'],
    uploadSecret: 'YT_REFRESH_TOKEN_WORLD',
  },
  bharat: {
    id: 'bharat',
    label: 'Agyata भारत',
    lang: 'h', // Kokoro Hindi (handles Hinglish — Hindi with English proper nouns)
    voice: process.env.SHORTS_VOICE_BHARAT || 'hf_alpha',
    espeakLang: 'hi', // espeak-ng Hindi phonemization (correct Devanagari → IPA)
    scriptLang: 'hi',
    font: FONTS.deva,
    apiMode: 'latest',
    categoryPriority: ['top', 'politics', 'entertainment', 'sports', 'business', 'world'],
    ctaLine: 'पूरी खबर → agyata.com',
    subCta: 'भारत की खबरों के लिए Subscribe करें',
    hashtags: ['#shorts', '#news', '#hindinews', '#breaking', '#india'],
    uploadSecret: 'YT_REFRESH_TOKEN_BHARAT',
  },
};

export function channel(id) {
  const c = CHANNELS[id];
  if (!c) throw new Error(`unknown channel '${id}' (want: world | bharat)`);
  return c;
}

export const API_BASE = process.env.API_BASE || 'https://api.agyata.com';
export const STAGE_DIR = process.env.SHORTS_STAGE_DIR || join(ROOT, 'docs', 'shorts');
export const WORK_DIR = process.env.SHORTS_WORK_DIR || join(ROOT, '.shorts-work');
export const MUSIC_DIR = process.env.SHORTS_MUSIC_DIR || join(ROOT, 'shorts', 'assets', 'music');
export const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
// Extra free stock providers (fallbacks after story-image + Pexels). Secret names match
// what's set on GitHub: PIXBAY_API_KEY (sic) + UNSPLASH_ACCESS_KEY.
export const PIXABAY_KEY = process.env.PIXBAY_API_KEY || '';
export const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY || '';
