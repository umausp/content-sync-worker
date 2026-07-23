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
export async function renderSegment({ bgPath, bgPaths, bgWindows, chromePath, captions, narrationWav, dur, outPath }) {
  const { width: W, height: H, fps } = VIDEO;
  // MULTI-IMAGE background: a story now carries several images from its sources; show
  // them in sequence across the segment (each with a Ken-Burns zoom, crossfaded) so the
  // clip isn't one static photo. `bgWindows` (Gap 1) is the shot-planner output —
  // [{ path, start, end }] tiling [0,dur] — which times each image to the words being
  // spoken (an entity photo appears when its name is said). If absent we fall back to
  // `bgPaths` (equal slices) then the single `bgPath`.
  let bgs, durs;
  if (bgWindows && bgWindows.length) {
    bgs = bgWindows.map((w) => w.path).filter(Boolean);
    durs = bgWindows.map((w) => Math.max(0.05, w.end - w.start));
  } else {
    bgs = (bgPaths && bgPaths.length ? bgPaths : [bgPath]).filter(Boolean);
    durs = bgs.map(() => dur / bgs.length); // equal slices (legacy behaviour)
  }
  const parts = [];

  // Build the background track.
  if (bgs.length === 1) {
    const frames = Math.max(1, Math.round(dur * fps));
    parts.push(
      `[0:v]zoompan=z='min(zoom+0.0009,1.12)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},format=yuva420p[bg]`,
    );
  } else {
    // crossfade seconds — shrink it if the shortest on-screen window is brief so a quick
    // cutaway never gets swallowed whole by the transition (keeps every image visible).
    const minDur = Math.min(...durs);
    const XF = Math.min(0.5, Math.max(0.12, minDur * 0.6));
    // Each image is a bounded clip of its own on-screen duration `durs[i]` with a Ken-Burns
    // zoom; consecutive clips overlap by XF so the xfade chain lands them back-to-back and
    // the whole thing runs exactly `dur`. Non-last clips carry a +XF tail for the overlap;
    // the running xfade offset is the CUMULATIVE on-screen duration (generalises the old
    // uniform `i*slice` to arbitrary per-image windows from the planner).
    bgs.forEach((_p, i) => {
      const clipLen = i < bgs.length - 1 ? durs[i] + XF : durs[i]; // last needs no tail overlap
      const f = Math.max(1, Math.round(clipLen * fps));
      const z = i % 2 === 0 ? `min(zoom+0.0015,1.16)` : `if(lte(zoom,1.0),1.16,max(1.0,zoom-0.0015))`;
      // zoompan d=f gives the clip f frames; trim bounds it; setpts resets its clock so
      // xfade offsets are measured from each input's own start.
      parts.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
        `zoompan=z='${z}':d=${f}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
        `trim=duration=${clipLen.toFixed(3)},setpts=PTS-STARTPTS,format=yuva420p[z${i}]`,
      );
    });
    // Chain xfades: the offset for merging clip i is the running track length minus XF,
    // which equals the cumulative on-screen duration of clips 0..i-1. Track it explicitly.
    let prev = 'z0';
    let running = durs[0] + XF; // length of z0's clip
    for (let i = 1; i < bgs.length; i++) {
      const off = running - XF; // start the crossfade XF before the current track ends
      const out = i === bgs.length - 1 ? 'bg' : `xf${i}`;
      parts.push(`[${prev}][z${i}]xfade=transition=fade:duration=${XF}:offset=${off.toFixed(3)}[${out}]`);
      const thisLen = i < bgs.length - 1 ? durs[i] + XF : durs[i];
      running = off + XF + (thisLen - XF); // new track length after this xfade
      prev = out;
    }
  }

  const nBg = bgs.length;
  parts.push(`[bg][${nBg}:v]overlay=0:0:format=auto[base]`); // chrome is input nBg
  let last = 'base';
  captions.forEach((c, i) => {
    const inIdx = nBg + 1 + i; // captions start after bgs + chrome
    const out = i === captions.length - 1 ? 'vout' : `v${i}`;
    parts.push(
      `[${last}][${inIdx}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[${out}]`,
    );
    last = out;
  });
  if (captions.length === 0) parts.push(`[base]null[vout]`);
  const idxNar = nBg + 1 + captions.length;
  parts.push(`[${idxNar}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad[aout]`);

  const args = ['-y', '-loglevel', 'error'];
  for (const b of bgs) args.push('-loop', '1', '-i', b); // 0..nBg-1 backgrounds
  args.push('-loop', '1', '-i', chromePath); // nBg
  for (const c of captions) args.push('-loop', '1', '-i', c.png); // nBg+1..
  args.push('-i', narrationWav);
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
  await execFileP('ffmpeg', args, { maxBuffer: 96 * 1024 * 1024 });
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
    // AUDIBLE-BEAT MIX. The old chain (amix average → loudnorm whole mix) crushed the
    // beat inaudible: amix halved it, then loudnorm renormalized to the voice level.
    // Fix: (1) loudnorm the VOICE to target FIRST; (2) fixed-gain the beat; (3) amix
    // with normalize=0 + weights so the beat keeps a real, fixed presence under the
    // voice (no second full-mix loudnorm). Beat ≈ 0.28 sits clearly under speech.
    const beatGain = Number(process.env.SHORTS_MUSIC_GAIN || 0.28);
    const filter =
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
      `loudnorm=I=${VIDEO.lufs}:TP=-1.5:LRA=11[nar];` +
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${totalDur.toFixed(3)},` +
      `volume=${beatGain},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, totalDur - 2).toFixed(3)}:d=2[mus];` +
      `[nar][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
      `alimiter=limit=0.95[aout]`;
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
