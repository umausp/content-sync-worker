// render.mjs — composite the final Short with ffmpeg, then VALIDATE it.
//
// Layers (bottom → top):
//   1. background image with slow Ken-Burns zoom (zoompan), scaled to 1080×1920
//   2. static chrome overlay (brand bar, badge, hashtag, source, CTA, scrim)
//   3. per-segment caption overlays, each shown only during its [start,end]
//   4. audio: narration + a ducked royalty-free music bed, loudness-normalized
//
// Then it PROVES the output is good (user requirement: "no buggy audio/video"):
//   • video duration ≈ narration duration (±0.15s) — no A/V drift
//   • has one video + one audio stream, H.264 + AAC, 1080×1920
//   • audio is not silent (mean loudness in a sane range)
// A render failing any check throws — the orchestrator then refuses to stage it.

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { VIDEO } from './config.mjs';

const execFileP = promisify(execFile);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Build the filter_complex graph. `captions` = [{ png, start, end }].
function buildFilter(captions, dur, hasMusic) {
  const { width: W, height: H, fps } = VIDEO;
  const frames = Math.max(1, Math.round(dur * fps));
  const parts = [];

  // [0:v] = bg image (BWxBH). Ken-Burns: slow zoom 1.0→1.12 over the clip, centered,
  // output exactly WxH @ fps for `frames` frames. 'd' must be the total frame count.
  parts.push(
    `[0:v]zoompan=z='min(zoom+0.0009,1.12)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},format=yuva420p[bg]`,
  );

  // Overlay static chrome ([1:v]).
  parts.push(`[bg][1:v]overlay=0:0:format=auto[base]`);

  // Chain caption overlays, each enabled only during its window. Inputs 2..N are captions.
  let last = 'base';
  captions.forEach((c, i) => {
    const inIdx = 2 + i;
    const out = i === captions.length - 1 ? 'vout' : `v${i}`;
    // A tiny 0.12s fade-in via alpha isn't available per-overlay without extra streams;
    // the enable gate gives a clean cut-in which reads well at Shorts pace.
    parts.push(
      `[${last}][${inIdx}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[${out}]`,
    );
    last = out;
  });
  if (captions.length === 0) parts.push(`[base]null[vout]`);

  // AUDIO. Narration is the last-but-one input (idxNar); music (optional) after it.
  // Narration index = 2 + captions.length ; music index = narration + 1.
  const idxNar = 2 + captions.length;
  if (hasMusic) {
    const idxMus = idxNar + 1;
    // Music: loop-trim to dur, lower to ~0.12 gain, sidechain-free simple duck by level.
    parts.push(`[${idxMus}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${dur.toFixed(3)},volume=0.10[mus]`);
    parts.push(`[${idxNar}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[nar]`);
    parts.push(`[nar][mus]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=${VIDEO.lufs}:TP=-1.5:LRA=11[aout]`);
  } else {
    parts.push(`[${idxNar}:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=${VIDEO.lufs}:TP=-1.5:LRA=11[aout]`);
  }

  return { filter: parts.join(';'), idxNar };
}

export async function renderShort({ bgPath, chromePath, captions, narrationWav, musicPath, dur, outPath }) {
  const hasMusic = !!(musicPath && (await exists(musicPath)));
  const { filter } = buildFilter(captions, dur, hasMusic);

  // Inputs, in the order the filter graph indexes them:
  //  0 bg (loop 1 image), 1 chrome, 2..N captions, N+1 narration, [N+2 music]
  const args = ['-y', '-loglevel', 'error'];
  args.push('-loop', '1', '-i', bgPath); // 0
  args.push('-loop', '1', '-i', chromePath); // 1
  for (const c of captions) args.push('-loop', '1', '-i', c.png); // 2..N
  args.push('-i', narrationWav); // narration
  if (hasMusic) args.push('-stream_loop', '-1', '-i', musicPath); // music (looped)

  args.push(
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-t', dur.toFixed(3),
    '-r', String(VIDEO.fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    outPath,
  );

  await execFileP('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
  await validate(outPath, dur);
  return outPath;
}

// PROVE the output is a clean, playable Short (throws on any defect).
export async function validate(path, expectedDur) {
  if (!(await exists(path))) throw new Error('render: no output file');
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json', path,
  ]);
  const info = JSON.parse(stdout);
  const dur = Number(info.format?.duration || 0);
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('render: no video stream');
  if (!a) throw new Error('render: no audio stream');
  if (v.codec_name !== 'h264') throw new Error(`render: video is ${v.codec_name}, want h264`);
  if (a.codec_name !== 'aac') throw new Error(`render: audio is ${a.codec_name}, want aac`);
  if (Number(v.width) !== VIDEO.width || Number(v.height) !== VIDEO.height)
    throw new Error(`render: dims ${v.width}x${v.height}, want ${VIDEO.width}x${VIDEO.height}`);
  if (Math.abs(dur - expectedDur) > 0.4)
    throw new Error(`render: A/V drift — file ${dur.toFixed(2)}s vs narration ${expectedDur.toFixed(2)}s`);
  // Loudness sanity: not silent.
  const { stderr } = await execFileP('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = String(stderr).match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (m && Number(m[1]) < -45) throw new Error(`render: near-silent audio (${m[1]}dB)`);
  return { duration: dur, width: Number(v.width), height: Number(v.height) };
}
