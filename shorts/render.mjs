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
export async function renderSegment({ bgPath, bgPaths, chromePath, captions, narrationWav, dur, outPath }) {
  const { width: W, height: H, fps } = VIDEO;
  // MULTI-IMAGE background: a story now carries several images from its sources; show
  // them in sequence across the segment (each with a Ken-Burns zoom, crossfaded) so the
  // clip isn't one static photo. Falls back to the single bgPath. `bgPaths` is an
  // ordered list of canvas-sized PNGs; each gets an equal slice of `dur`.
  const bgs = (bgPaths && bgPaths.length ? bgPaths : [bgPath]).filter(Boolean);
  const XF = 0.5; // crossfade seconds between images
  const parts = [];

  // Build the background track.
  if (bgs.length === 1) {
    const frames = Math.max(1, Math.round(dur * fps));
    parts.push(
      `[0:v]zoompan=z='min(zoom+0.0009,1.12)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},format=yuva420p[bg]`,
    );
  } else {
    // Each image is a bounded `slice`-second clip with a Ken-Burns zoom; consecutive
    // clips overlap by XF so the xfade chain lands them back-to-back and the whole
    // thing runs exactly `dur`. Each clip is length = slice + XF (except the last),
    // so after N-1 xfades of XF each the timeline = N*slice = dur.
    const slice = dur / bgs.length;
    bgs.forEach((_p, i) => {
      const clipLen = i < bgs.length - 1 ? slice + XF : slice; // last needs no tail overlap
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
    // Chain xfades: offset for step i = i*slice - XF... but on the GROWING track the
    // running length after k merges = (k)*slice + XF, so each next xfade offset is the
    // running length minus XF = k*slice. Track it explicitly.
    let prev = 'z0';
    let running = slice + XF; // length of z0's clip
    for (let i = 1; i < bgs.length; i++) {
      const off = running - XF; // start the crossfade XF before the current track ends
      const out = i === bgs.length - 1 ? 'bg' : `xf${i}`;
      parts.push(`[${prev}][z${i}]xfade=transition=fade:duration=${XF}:offset=${off.toFixed(3)}[${out}]`);
      const thisLen = i < bgs.length - 1 ? slice + XF : slice;
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
    // [0] concatenated clips (video+narration), [1] music looped.
    const filter =
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${totalDur.toFixed(3)},` +
      `volume=0.16,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, totalDur - 2).toFixed(3)}:d=2[mus];` +
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
