// config.mjs — per-channel configuration for the Agyata Shorts pipeline.
//
// Two channels, one engine (see docs/youtube/SHORTS_PIPELINE_DESIGN.md):
//   • world  — ENGLISH, US/UK/global audience → tier-1 CPM (the earnings engine)
//   • bharat — HINDI/HINGLISH, India audience → reach + app funnel (the growth engine)
//
// Everything tunable via env so the GitHub Actions workflow can override per run.

import { join } from 'node:path';

export const ROOT = process.cwd();

// NOTE: the bundled premium caption faces (Montserrat/Anton/Baloo 2 in shorts/assets/fonts)
// are made resolvable by fonts.mjs `ensureFonts()`, which INSTALLS them into the OS user-font
// dir at render startup — because rsvg's pango backend ignores $FONTCONFIG_FILE on macOS
// (CoreText) while honouring it on Linux, so a repo fonts.conf alone fails on a Mac. See
// fonts.mjs for the full rationale. The FONTS stacks below name those families.
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

// Fonts. We BUNDLE premium OFL faces (shorts/assets/fonts) and resolve them via the repo
// fontconfig set above, so captions match the bold "Premiere Pro / CapCut" look top faceless
// channels use — NOT the generic Arial Black that shipped before. SVG uses font-family names;
// rsvg resolves via fontconfig. Each stack ends in the OS fallbacks so a missing glyph never
// tofus. (user: "use good font like [top Shorts channels]".)
//   • latin — Montserrat is the clean, geometric, heavy caption face those channels favour;
//     Anton is the ultra-condensed heavy variant kept for the CHROME headline punch.
//   • deva  — Baloo 2 is a chunky rounded bold with FULL Devanagari coverage, then Kohinoor/
//     Noto Devanagari fallback so Hindi always renders.
export const FONTS = {
  latin: "'Montserrat','Arial Black','Arial',sans-serif",
  display: "'Anton','Montserrat','Arial Black',sans-serif", // ultra-heavy display (headlines/badges)
  // Devanagari-capable stack. Baloo 2 (bundled) leads; Kohinoor (mac) / Noto (Ubuntu) fallback.
  deva: "'Baloo 2','Kohinoor Devanagari','Noto Sans Devanagari','Nirmala UI','Arial Unicode MS',sans-serif",
  // CJK stack for the Japanese channel. Noto Sans CJK JP is installed on CI via
  // `apt-get install fonts-noto-cjk`; Hiragino (mac) / Yu Gothic (win) / Arial Unicode fall
  // back locally so kanji/kana never tofu. Heavy weight requested in the caption renderer.
  cjk: "'Noto Sans CJK JP','Noto Sans JP','Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo','Arial Unicode MS',sans-serif",
};

export const CHANNELS = {
  world: {
    id: 'world',
    label: 'Agyata World',
    // Neutral British/RP is the single best voice for a channel serving BOTH US + UK:
    // a Podcastle survey found British = most-trusted (42%) + most-appealing (46%) with
    // US audiences, and 48% of Americans prefer British on short-form. bm_george (Kokoro
    // British male, lang 'b') + espeak en-gb = calm-authoritative BBC-style news read.
    lang: 'b', // Kokoro British English
    voice: process.env.SHORTS_VOICE_WORLD || 'bm_george',
    espeakLang: 'en-gb',
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

// ── NATIVE-LANGUAGE CHANNELS (all on @AgyataWorld, uploaded UNLISTED to a per-language
// playlist) ──────────────────────────────────────────────────────────────────────────────
// User directive: the World channel stays ENGLISH-ONLY (no translation); each of these is a
// SEPARATE pipeline that gathers, synthesizes, voices and captions news natively IN ITS OWN
// LANGUAGE — its own images, full research/dedup/synth, uploaded to a playlist named by the
// language code (DE/NL/FR/JP/SV/NO/DA). Fields:
//   scriptLang — ISO content language: drives native gather (native_feeds NATIVE_SPECS key),
//                native LLM synth (enrichSummary lang), font choice + caption script handling.
//   lang       — TTS-engine language code. Kokoro needs its own codes (fr='f', ja='j'); Piper
//                ignores it (the voice model fixes the language) so we pass scriptLang there.
//   ttsEngine  — 'kokoro' (FR/JP — Kokoro speaks these) | 'piper' (DE/NL/SV/NO/DA — Kokoro
//                can't, Piper can). build_short dispatches to kokoro_tts.py / piper_tts.py.
//   voice      — Kokoro voice id OR Piper voice key (locale-name-quality; downloaded on first
//                use from rhasspy/piper-voices).
//   playlist   — the @AgyataWorld playlist name to add the upload to (upload.mjs resolves it).
// NOTE: all reuse YT_REFRESH_TOKEN_WORLD — every native channel is a playlist on @AgyataWorld,
// not a separate YouTube channel, so it authenticates with the World channel's token.
const NATIVE_CHANNELS = [
  {
    id: 'de', label: 'Agyata Welt', scriptLang: 'de', lang: 'de', ttsEngine: 'piper',
    voice: process.env.SHORTS_VOICE_DE || 'de_DE-thorsten-high', espeakLang: 'de', font: FONTS.latin,
    ctaLine: 'Ganze Story → agyata.com', subCta: 'Für Weltnachrichten abonnieren',
    hashtags: ['#shorts', '#nachrichten', '#news', '#weltnachrichten'],
  },
  {
    id: 'nl', label: 'Agyata Wereld', scriptLang: 'nl', lang: 'nl', ttsEngine: 'piper',
    voice: process.env.SHORTS_VOICE_NL || 'nl_NL-mls-medium', espeakLang: 'nl', font: FONTS.latin,
    ctaLine: 'Volledig verhaal → agyata.com', subCta: 'Abonneer voor wereldnieuws',
    hashtags: ['#shorts', '#nieuws', '#news', '#wereldnieuws'],
  },
  {
    id: 'fr', label: 'Agyata Monde', scriptLang: 'fr', lang: 'f', ttsEngine: 'kokoro',
    voice: process.env.SHORTS_VOICE_FR || 'ff_siwis', espeakLang: 'fr-fr', font: FONTS.latin,
    ctaLine: 'Article complet → agyata.com', subCta: "Abonnez-vous pour l'actu mondiale",
    hashtags: ['#shorts', '#actualités', '#news', '#infomonde'],
  },
  {
    id: 'jp', label: 'Agyata ワールド', scriptLang: 'ja', lang: 'j', ttsEngine: 'kokoro',
    voice: process.env.SHORTS_VOICE_JP || 'jf_alpha', espeakLang: 'ja', font: FONTS.cjk,
    ctaLine: '詳細は agyata.com へ', subCta: 'ワールドニュースは登録を',
    hashtags: ['#shorts', '#ニュース', '#news', '#速報'],
  },
  {
    id: 'sv', label: 'Agyata Världen', scriptLang: 'sv', lang: 'sv', ttsEngine: 'piper',
    voice: process.env.SHORTS_VOICE_SV || 'sv_SE-nst-medium', espeakLang: 'sv', font: FONTS.latin,
    ctaLine: 'Hela storyn → agyata.com', subCta: 'Prenumerera för världsnyheter',
    hashtags: ['#shorts', '#nyheter', '#news', '#världsnyheter'],
  },
  {
    id: 'no', label: 'Agyata Verden', scriptLang: 'no', lang: 'no', ttsEngine: 'piper',
    voice: process.env.SHORTS_VOICE_NO || 'no_NO-talesyntese-medium', espeakLang: 'nb', font: FONTS.latin,
    ctaLine: 'Hele saken → agyata.com', subCta: 'Abonner for verdensnyheter',
    hashtags: ['#shorts', '#nyheter', '#news', '#verdensnyheter'],
  },
  {
    id: 'da', label: 'Agyata Verden', scriptLang: 'da', lang: 'da', ttsEngine: 'piper',
    voice: process.env.SHORTS_VOICE_DA || 'da_DK-talesyntese-medium', espeakLang: 'da', font: FONTS.latin,
    ctaLine: 'Hele historien → agyata.com', subCta: 'Abonner for verdensnyheder',
    hashtags: ['#shorts', '#nyheder', '#news', '#verdensnyheder'],
  },
];
for (const n of NATIVE_CHANNELS) {
  CHANNELS[n.id] = {
    id: n.id,
    label: n.label,
    lang: n.lang, // TTS-engine lang code (Kokoro f/j; Piper = scriptLang, ignored by Piper)
    scriptLang: n.scriptLang, // ISO content language — gather/synth/font/caption driver
    nativeLang: n.scriptLang, // key into native_feeds NATIVE_SPECS (de/nl/fr/ja/sv/no/da)
    ttsEngine: n.ttsEngine, // 'kokoro' | 'piper'
    voice: n.voice,
    espeakLang: n.espeakLang,
    font: n.font,
    native: true, // marks a native-language channel (build_short dispatches its gather here)
    // No apiMode / categoryFit: native channels source from native_feeds, not the India API.
    ctaLine: n.ctaLine,
    subCta: n.subCta,
    hashtags: n.hashtags,
    // Playlist named by the uppercase language code on @AgyataWorld (user creates them).
    playlist: n.id.toUpperCase(),
    uploadSecret: 'YT_REFRESH_TOKEN_WORLD', // all native channels live on @AgyataWorld
  };
}

export function channel(id) {
  const c = CHANNELS[id];
  if (!c) throw new Error(`unknown channel '${id}' (want: world | bharat | de | nl | fr | jp | sv | no | da)`);
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
