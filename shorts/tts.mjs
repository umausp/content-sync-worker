// tts.mjs — text → narrated audio + word-level timings, for the Shorts renderer.
//
// Uses Microsoft edge-tts (free, no API key, natural Indian-English neural voices)
// via a project-local venv. For EACH segment we produce:
//   • <seg>.mp3   — the spoken audio
//   • <seg>.vtt   — word/phrase boundary timings (edge-tts --write-subtitles)
// The VTT drives the on-screen captions so words appear in sync with the voice —
// the single biggest "watchable" factor for Shorts.
//
// Voices (verified available): en-IN-PrabhatNeural (male, "ARJUN"),
// en-IN-NeerjaNeural (female, "PRIYA"). Hindi: hi-IN-MadhurNeural / hi-IN-SwaraNeural.
//
// Robustness: every synth is retried; a segment that repeatedly fails throws with
// a clear message (the caller aborts the whole render rather than ship silent gaps).
// Output audio is validated (non-trivial duration + real loudness) before use.

import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// The venv python that has edge-tts installed. Override with SHORTS_PY.
export const PY = process.env.SHORTS_PY || '/tmp/ytenv/bin/python';

export const VOICES = {
  // logical host name → edge-tts voice id
  ARJUN: process.env.SHORTS_VOICE_A || 'en-IN-PrabhatNeural',
  PRIYA: process.env.SHORTS_VOICE_B || 'en-IN-NeerjaNeural',
  NARRATOR: process.env.SHORTS_VOICE_N || 'en-IN-NeerjaNeural',
  HINDI_M: 'hi-IN-MadhurNeural',
  HINDI_F: 'hi-IN-SwaraNeural',
};

// edge-tts prosody knobs — a touch slower + slightly higher pitch reads as
// energetic-but-clear for news Shorts. Tunable via env.
const RATE = process.env.SHORTS_TTS_RATE || '+6%';
const PITCH = process.env.SHORTS_TTS_PITCH || '+0Hz';

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Probe an audio file: returns { duration, meanDb }. Throws if unreadable.
export async function probeAudio(path) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', path,
  ]);
  const duration = Number(String(stdout).trim());
  // Loudness via volumedetect (mean_volume). Silence ≈ -91 dB; speech ≈ -14..-24.
  let meanDb = Number.NaN;
  try {
    const { stderr } = await execFileP('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
    const m = String(stderr).match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    if (m) meanDb = Number(m[1]);
  } catch {
    /* volumedetect writes to stderr + exits 0; if it throws, leave meanDb NaN */
  }
  return { duration: Number.isFinite(duration) ? duration : 0, meanDb };
}

// Synthesize ONE segment. `id` names the output files. Returns
// { mp3, vtt, voice, duration }. Retries transient network/service failures.
export async function synth(text, voice, outDir, id, { retries = 3 } = {}) {
  await mkdir(outDir, { recursive: true });
  const mp3 = join(outDir, `${id}.mp3`);
  const vtt = join(outDir, `${id}.vtt`);
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error(`tts: empty text for segment ${id}`);

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await execFileP(
        PY,
        [
          '-m', 'edge_tts',
          '--voice', voice,
          '--rate', RATE,
          '--pitch', PITCH,
          '--text', clean,
          '--write-media', mp3,
          '--write-subtitles', vtt,
        ],
        { timeout: 60_000 },
      );
      // Validate: file exists, has real duration + real loudness (not silence).
      if (!(await fileExists(mp3))) throw new Error('no audio written');
      const { duration, meanDb } = await probeAudio(mp3);
      if (duration < 0.15) throw new Error(`audio too short (${duration}s)`);
      if (Number.isFinite(meanDb) && meanDb < -55) throw new Error(`audio near-silent (${meanDb}dB)`);
      return { mp3, vtt: (await fileExists(vtt)) ? vtt : null, voice, duration };
    } catch (e) {
      lastErr = e;
      // brief backoff between attempts (deterministic — no Math.random)
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(`tts: segment ${id} failed after ${retries} attempts: ${lastErr?.message || lastErr}`);
}

// Parse an edge-tts VTT into [{ start, end, text }] cues (seconds). edge-tts emits
// SRT-style "HH:MM:SS,mmm" timestamps inside a .vtt; handle both ',' and '.'.
export function parseVtt(vttText) {
  const cues = [];
  const re =
    /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})([\s\S]*?)(?=\n\s*\n|\n\s*\d+\s*\n|$)/g;
  const toSec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  let match;
  for (;;) {
    match = re.exec(vttText);
    if (!match) break;
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2, body] = match;
    const text = String(body).replace(/^\s*\d+\s*$/gm, '').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start: toSec(h1, m1, s1, ms1), end: toSec(h2, m2, s2, ms2), text });
  }
  return cues;
}
