// render.mjs — render a multi-story Shorts roundup, then VALIDATE it.
//
// Strategy: render EACH story as its own self-contained clip (its background with a
// slow Ken-Burns zoom + the static chrome + that story's synced caption overlays +
// that story's narration), then CONCAT the clips and mix a low music bed over the
// whole thing. Per-clip rendering keeps each filter graph small + robust (vs. one
// giant graph with N backgrounds and 3N caption overlays), and the concat gives a
// clean multi-story "Top 5" video.
//
// Output is then PROVEN clean (user req: "no buggy audio/video"): 1080x1920 H.264+AAC,
// audio≈video duration, not silent — or it throws and nothing is staged.

import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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

// Render ONE story clip: bg (Ken-Burns) + chrome + captions + narration. No music
// here (mixed once over the concatenated whole). `captions` = [{ png, start, end }]
// with times RELATIVE to this clip. Returns outPath.
export async function renderSegment({ bgPath, chromePath, captions, narrationWav, dur, outPath }) {
  const { width: W, height: H, fps } = VIDEO;
  const frames = Math.max(1, Math.round(dur * fps));
  const parts = [];
  // Ken-Burns zoom on the bg.
  parts.push(
    `[0:v]zoompan=z='min(zoom+0.0009,1.12)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},format=yuva420p[bg]`,
  );
  parts.push(`[bg][1:v]overlay=0:0:format=auto[base]`);
  let last = 'base';
  captions.forEach((c, i) => {
    const inIdx = 2 + i;
    const out = i === captions.length - 1 ? 'vout' : `v${i}`;
    parts.push(
      `[${last}][${inIdx}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[${out}]`,
    );
    last = out;
  });
  if (captions.length === 0) parts.push(`[base]null[vout]`);
  const idxNar = 2 + captions.length;
  // Narration only; pad to the clip duration so video+audio lengths match exactly.
  parts.push(`[${idxNar}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad[aout]`);

  const args = ['-y', '-loglevel', 'error'];
  args.push('-loop', '1', '-i', bgPath); // 0
  args.push('-loop', '1', '-i', chromePath); // 1
  for (const c of captions) args.push('-loop', '1', '-i', c.png); // 2..N
  args.push('-i', narrationWav); // narration
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', dur.toFixed(3),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    outPath,
  );
  await execFileP('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
  return outPath;
}

// Concatenate story clips (re-encode for safety — sources are already uniform, but
// concat-demuxer copy can glitch on tiny timestamp diffs) and mix a low music bed
// under the whole thing, loudness-normalized. Then validate.
export async function concatWithMusic({ segmentPaths, musicPath, outPath, totalDur }) {
  const hasMusic = !!(musicPath && (await exists(musicPath)));
  const listFile = join(dirname(outPath), 'concat.txt');
  await writeFile(listFile, segmentPaths.map((p) => `file '${p}'`).join('\n'));

  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (hasMusic) args.push('-stream_loop', '-1', '-i', musicPath);

  if (hasMusic) {
    // [0] concatenated clips (video+narration), [1] music looped.
    const filter =
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${totalDur.toFixed(3)},` +
      `volume=0.22,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, totalDur - 2).toFixed(3)}:d=2[mus];` +
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.0[nar];` +
      `[nar][mus]amix=inputs=2:duration=first:dropout_transition=0,` +
      `loudnorm=I=${VIDEO.lufs}:TP=-1.5:LRA=11[aout]`;
    args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]');
  } else {
    args.push(
      '-af', `loudnorm=I=${VIDEO.lufs}:TP=-1.5:LRA=11`,
      '-map', '0:v', '-map', '0:a',
    );
  }
  args.push(
    '-r', String(VIDEO.fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    outPath,
  );
  await execFileP('ffmpeg', args, { maxBuffer: 128 * 1024 * 1024 });
  await validate(outPath, totalDur);
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
  if (expectedDur && Math.abs(dur - expectedDur) > 1.0)
    throw new Error(`render: duration drift — file ${dur.toFixed(2)}s vs expected ${expectedDur.toFixed(2)}s`);
  const { stderr } = await execFileP('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = String(stderr).match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (m && Number(m[1]) < -45) throw new Error(`render: near-silent audio (${m[1]}dB)`);
  return { duration: dur, width: Number(v.width), height: Number(v.height) };
}
