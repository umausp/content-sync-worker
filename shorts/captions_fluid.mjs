// captions_fluid.mjs — SMOOTH, premium karaoke captions for the "supply your own
// audio/text/images" path (make_video.mjs → build_from_audio.mjs).
//
// WHY A SEPARATE RENDERER: this ffmpeg build has NO libass and NO drawtext, so the easy
// ASS "\k" karaoke route is impossible. frames.mjs `buildKaraokeCaptions` renders ONE PNG
// per word and hard-cuts between them with overlay enable='between(t,…)' — which visibly
// JUMPS (steppy). To get the fluid "word smoothly pops/bounces, one word focused" look top
// faceless channels use, we pre-render the caption band as a PER-FRAME alpha video track
// (qtrle .mov) with eased motion, then overlay it ONCE. Everything is interpolated per frame,
// so scale/rise/colour move continuously instead of snapping.
//
// STYLE (user spec, this path only):
//   • Montserrat only — big + bold (no Anton mix). Hindi keeps its Devanagari face (cfg.font
//     already resolves per channel; Montserrat has no Devanagari glyphs).
//   • Up to 2 lines on screen (a "phrase"), text shown VERBATIM (never translated).
//   • The word being spoken smoothly swells (ease-out), lifts, and turns brand-yellow; its
//     neighbours ease back down. New phrases fade + slide up in.
//
// Text is rendered as SVG → PNG via rsvg-convert (same rasteriser as the rest of the pipe),
// frames that don't change are de-duplicated (a copy, not a re-raster) so the long "hold"
// stretches cost almost nothing, and unique frames rasterise in a CPU pool.

import { execFile } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { VIDEO } from './config.mjs';
import { wordTimings, isCjk } from './word_timing.mjs';
import { ensureFonts } from './fonts.mjs';

const execFileP = promisify(execFile);

// ── animation tuning ────────────────────────────────────────────────────────
const POP = 1.18; // active word swells to 1.18× (the "pop") — modest so it never clips
const ENTER_DUR = 0.28; // seconds: a new phrase fades + slides up over this
const ENTER_DY = 48; // px the phrase travels up as it enters
const ATTACK = 0.1; // seconds a word takes to swell IN as it starts being spoken
const RELEASE = 0.08; // seconds a word takes to settle back after it's spoken
const MAX_LINES = 2; // never more than 2 lines on screen (user: "2 lines")
const YELLOW = { g: 212, b: 0 }; // #ffd400 target for the active word (from white)

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const cp = (s) => [...String(s || '')].length; // code-point length (Devanagari-safe)

// Smooth focus bump for one word: 0 outside its window, eases 0→1 over ATTACK at its start,
// holds at 1, eases 1→0 over RELEASE at its end. Because word windows are contiguous, the
// release of one word overlaps the attack of the next → a clean crossfade of the "pop" from
// word to word (no hard switch). Attack/release shrink for very short words so the peak still
// lands mid-word.
function focus(t, s, e, attack, release) {
  if (t <= s || t >= e) return 0;
  const dur = e - s;
  const a = Math.min(attack, dur / 2);
  const r = Math.min(release, dur / 2);
  if (t < s + a) return easeOutCubic((t - s) / a);
  if (t > e - r) return easeOutCubic((e - t) / r);
  return 1;
}

// White (#ffffff) → brand yellow (#ffd400), interpolated by the focus factor.
function lerpColor(f) {
  const g = Math.round(255 - (255 - YELLOW.g) * f);
  const b = Math.round(255 - (255 - YELLOW.b) * f);
  return `rgb(255,${g},${b})`;
}

// Greedy word-wrap into lines. `charW` (width per char as a fraction of font size) is used
// ONLY to decide WHERE to break lines — an aesthetic call, not a correctness one: the frame
// renderer flows words as inline <tspan>s so pango computes exact glyph advances and words
// can NEVER overlap regardless of how far off this estimate is. Returns an array of word
// arrays (each inner array = one line's word-timing objects).
function wrapWords(words, F, safeW, charW) {
  const gap = F * 0.34;
  const width = (w) => Math.max(1, cp(w.word)) * F * charW;
  const lines = [];
  let line = [];
  let w = 0;
  for (const it of words) {
    const wd = width(it);
    const add = (line.length ? gap : 0) + wd;
    if (line.length && w + add > safeW) {
      lines.push(line);
      line = [it];
      w = wd;
    } else {
      line.push(it);
      w += add;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

// Pack the word timeline into PHRASES that each fit in ≤ MAX_LINES lines, keeping the big
// font size (we show FEWER words per phrase rather than shrinking text). Each phrase carries
// its [start,end] from its first/last word + its pre-computed lines.
function packPhrases(words, F, safeW, charW) {
  const phrases = [];
  let cur = [];
  for (const w of words) {
    const trial = [...cur, w];
    if (!cur.length || wrapWords(trial, F, safeW, charW).length <= MAX_LINES) {
      cur = trial;
    } else {
      phrases.push(cur);
      cur = [w];
    }
  }
  if (cur.length) phrases.push(cur);
  return phrases.map((ws) => ({
    words: ws,
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    lines: wrapWords(ws, F, safeW, charW),
  }));
}

// One line of the phrase as a single centred <text> with inline-flowing <tspan>s. Because the
// tspans flow (no absolute x per word), pango lays them out with EXACT advances — the active
// word can swell (bigger font-size) and the rest re-flow around the centre with zero overlap.
// The per-word vertical lift is applied with CUMULATIVE dy deltas (SVG dy is relative), so a
// lifted word restores the baseline for the words after it.
function lineSvg(line, t, F, BW, y, cfg) {
  const strokeBase = F * 0.13;
  let curDy = 0;
  const spans = line
    .map((w, i) => {
      const f = focus(t, w.start, w.end, ATTACK, RELEASE);
      const fe = easeOutCubic(f);
      const fs = F * (1 + (POP - 1) * fe); // smooth swell via font-size (flows, never overlaps)
      const targetDy = -F * 0.06 * fe; // smooth lift
      const dy = targetDy - curDy; // relative delta (dy is cumulative in SVG)
      curDy = targetDy;
      const fill = lerpColor(f); // white → yellow
      const sw = (strokeBase * (1 + (POP - 1) * fe)).toFixed(1);
      // CJK (Japanese) has no inter-word spaces — a space between every segmented word looks
      // broken; Latin/Deva keep the trailing space between words.
      const gap = cfg.scriptLang === 'ja' ? '' : ' ';
      const txt = esc(w.word) + (i < line.length - 1 ? gap : '');
      return (
        `<tspan dy="${dy.toFixed(1)}" font-size="${fs.toFixed(1)}" fill="${fill}" ` +
        `stroke-width="${sw}">${txt}</tspan>`
      );
    })
    .join('');
  return (
    `<text x="${Math.round(BW / 2)}" y="${Math.round(y)}" font-family="${cfg.font}" font-weight="900" ` +
    `text-anchor="middle" xml:space="preserve" paint-order="stroke" stroke="#0a0118" ` +
    `stroke-linejoin="round">${spans}</text>`
  );
}

// Build ONE frame's SVG (band-sized, transparent). Shows the phrase active at time `t` with
// its entrance animation + every word at its current pop state.
function frameSvg(t, phrases, F, BW, BH, cfg) {
  let pi = 0;
  for (let k = 0; k < phrases.length; k++) {
    if (phrases[k].start <= t + 1e-6) pi = k;
    else break;
  }
  const ph = phrases[pi];
  const enter = easeOutCubic((t - ph.start) / ENTER_DUR);
  const gy = (1 - enter) * ENTER_DY; // slide up into place
  const lineH = F * 1.18;
  const blockH = ph.lines.length * lineH;
  const topY = (BH - blockH) / 2;
  const linesSvg = ph.lines
    .map((ln, li) => lineSvg(ln, t, F, BW, topY + li * lineH + F * 0.82, cfg))
    .join('');
  // Pill: generously sized from an estimate — it only needs to sit BEHIND the text, so
  // over-covering is harmless (a rounded translucent plate for legibility over photos).
  const est = Math.max(...ph.lines.map((ln) => ln.reduce((a, w) => a + cp(w.word) + 1, 0)), 1);
  const pillW = Math.min(BW - 24, Math.round(est * F * 0.6 * POP + F));
  const pill = {
    x: Math.round(BW / 2 - pillW / 2),
    y: Math.round(topY - F * 0.4),
    w: pillW,
    h: Math.round(blockH + F * 0.7),
  };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="${BH}" viewBox="0 0 ${BW} ${BH}">` +
    `<g transform="translate(0,${gy.toFixed(1)})" opacity="${clamp(enter, 0, 1).toFixed(3)}">` +
    `<rect x="${pill.x}" y="${pill.y}" width="${pill.w}" height="${pill.h}" rx="${Math.round(pill.h * 0.26)}" ` +
    `fill="#000000" fill-opacity="0.30"/>${linesSvg}</g></svg>`
  );
}

// Run an async fn over items with bounded concurrency (CPU pool for rsvg).
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Build a smooth alpha caption TRACK for a whole clip. `segments` = [{start,end,text}] (the
// aligner output). Returns { path, x, y } — an argb .mov the caller overlays once at (x,y).
// Returns null if there's no text to show.
export async function buildCaptionTrack(segments, cfg, outDir, { dur } = {}) {
  await ensureFonts();
  await mkdir(outDir, { recursive: true });
  const { width: W, height: H, fps, landscape: land } = VIDEO;
  const isDeva = cfg.scriptLang === 'hi';
  const isCjkChan = cfg.scriptLang === 'ja'; // full-width square glyphs, no spaces

  const words = wordTimings(segments);
  if (!words.length) return null;
  const total = Math.max(0.001, dur || words[words.length - 1].end);

  // Band geometry. Big font (user: "Big"); auto-shrink only if a single word wouldn't fit on
  // one line (rare). charW = width-per-char fraction of the font size (CJK glyphs ~ full width).
  const charW = isCjkChan ? 1.0 : isDeva ? 0.72 : 0.6;
  const margin = land ? 150 : 80;
  const safeW = W - 2 * margin;
  const minF = land ? 52 : 64;
  let F = land ? 76 : 92; // BIG
  const widestUnit = Math.max(...words.map((w) => Math.max(1, cp(w.word)) * charW), 1);
  while (F > minF && widestUnit * F > safeW) F -= 2;

  const BW = W;
  const BH = Math.round(F * 3.9); // holds 2 big lines + pop/rise headroom
  const bandCenterY = land ? H * 0.74 : H * 0.66;
  const bandY = Math.round(bandCenterY - BH / 2);

  // Pack the timeline into ≤2-line phrases once (line breaking is aesthetic; the frame
  // renderer flows words as inline tspans so they never overlap).
  const phrases = packPhrases(words, F, safeW, charW);

  // One SVG per frame; de-dup identical consecutive frames (the "hold" stretches) so we only
  // rasterise frames whose visual state actually changed.
  const N = Math.max(1, Math.round(total * fps));
  const svgs = new Array(N);
  for (let i = 0; i < N; i++) svgs[i] = frameSvg(i / fps, phrases, F, BW, BH, cfg);

  const pngPath = (i) => join(outDir, `cf-${String(i).padStart(5, '0')}.png`);
  const uniques = [];
  for (let i = 0; i < N; i++) if (i === 0 || svgs[i] !== svgs[i - 1]) uniques.push(i);

  await mapPool(uniques, cpus().length, async (i) => {
    const svgFile = join(outDir, `cf-${String(i).padStart(5, '0')}.svg`);
    await writeFile(svgFile, svgs[i]);
    await execFileP('rsvg-convert', ['-w', String(BW), '-h', String(BH), '-o', pngPath(i), svgFile]);
  });
  // Fill held frames by copying the run-start PNG (cheap; no re-raster).
  let runStart = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && svgs[i] !== svgs[i - 1]) runStart = i;
    if (i !== runStart) await copyFile(pngPath(runStart), pngPath(i));
  }

  // Encode the PNG sequence into an alpha .mov (qtrle keeps full alpha; identical frames cost
  // ~nothing via RLE + temporal delta).
  const track = join(outDir, 'captions.mov');
  await execFileP(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-framerate', String(fps),
      '-i', join(outDir, 'cf-%05d.png'),
      '-c:v', 'qtrle', '-pix_fmt', 'argb',
      track,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return { path: track, x: 0, y: bandY };
}
