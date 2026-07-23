// plan_shots.mjs — decide WHICH image is on screen WHEN (user: "I need the right image at
// the right time when it spells out on TTS").
//
// Today the render shows the story's images in EVEN slices (dur / N), with no link between
// an image and the words being spoken. This planner fixes that: given the per-word timeline
// (word_timing.mjs) and the entity NAME→IMAGE map (entity_images.mjs), it PINS each entity
// photo to the moment its name is spoken and fills the remaining time with the event photos —
// so "Christopher Nolan" shows Nolan's portrait exactly as the narrator says "Christopher
// Nolan", then cuts back to the event photo.
//
// Pure + deterministic (no I/O) so it's fully unit-testable. Output tiles [0, duration]
// contiguously: [{ path, url, kind, start, end }], every input image used exactly once.
// Degrades gracefully: no entity name spoken → plain even division (today's behaviour).

import { entitySpokenAt } from './word_timing.mjs';

// Even-split a list of shots across [start,end], preserving order. Last lands exactly on end.
function tileRange(items, start, end) {
  const n = items.length;
  if (!n) return [];
  const span = Math.max(0.001, end - start);
  const slice = span / n;
  return items.map((it, i) => ({
    ...it,
    start: start + i * slice,
    end: i === n - 1 ? end : start + (i + 1) * slice,
  }));
}

// Largest-remainder integer allocation of F fillers across regions weighted by their length,
// so a longer gap gets proportionally more event photos. Sum of the result === F exactly.
function allocate(F, lens) {
  const n = lens.length;
  if (!n || F <= 0) return new Array(n).fill(0);
  const total = lens.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // No room anywhere — dump everything into the last region (caller guards this case).
    const out = new Array(n).fill(0);
    out[n - 1] = F;
    return out;
  }
  const raw = lens.map((l) => (F * l) / total);
  const base = raw.map(Math.floor);
  let used = base.reduce((a, b) => a + b, 0);
  const byFrac = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (used < F && byFrac.length) {
    base[byFrac[k % byFrac.length].i]++;
    used++;
    k++;
  }
  return base;
}

// shots     : [{ path, url, kind }] — resolved (downloaded) background images, in priority order.
// entityShots: [{ name, url }]       — entity NAME→IMAGE pairs to pin to their spoken moment.
// timeline   : wordTimings(segments) — per-word [start,end] for the whole narration.
// duration   : total narration seconds.
// Returns [{ path, url, kind, start, end }] tiling [0, duration].
export function planShots({ shots, entityShots = [], timeline = [], duration, opts = {} }) {
  const minShot = opts.minShot ?? 1.6; // an entity photo stays up at least this long
  const hold = opts.hold ?? 0.5; // …plus a beat after the name finishes
  const leadIn = opts.leadIn ?? 0.25; // …and comes up slightly before the name starts
  const D = Math.max(0.1, Number(duration) || 0.1);
  const list = (shots || []).filter((s) => s && s.path);
  if (list.length <= 1) return list.map((s) => ({ ...s, start: 0, end: D }));

  // Which entity URLs are actually SPOKEN in this narration, and when.
  const spokenByUrl = new Map();
  for (const es of entityShots || []) {
    if (!es || !es.url) continue;
    const at = entitySpokenAt(es.name, timeline);
    if (at) spokenByUrl.set(es.url, at);
  }

  // Partition: anchors (entity photo whose name is spoken) vs fillers (event photos + any
  // entity photo whose name isn't spoken here — still shown, just not time-pinned).
  const anchors = [];
  const fillers = [];
  for (const s of list) {
    const at = spokenByUrl.get(s.url);
    if (at && !anchors.some((a) => a.url === s.url)) {
      anchors.push({ ...s, kind: 'entity', _c: (at.start + at.end) / 2, _s: at.start, _e: at.end });
    } else {
      fillers.push({ ...s, kind: s.kind || 'event' });
    }
  }

  // No entity moment to hit → today's behaviour: even division, order preserved.
  if (!anchors.length) return tileRange(fillers, 0, D).map(strip);

  // Order anchors by when their name is spoken, and give each a window centred on that.
  anchors.sort((a, b) => a._c - b._c);
  for (const a of anchors) {
    const want = Math.max(minShot, a._e - a._s + hold + leadIn);
    a.start = a._s - leadIn;
    a.end = Math.max(a.start + want, a._e + hold);
  }
  // De-overlap consecutive anchors by splitting the overlap at the midpoint; clamp to [0,D].
  anchors[0].start = Math.max(0, anchors[0].start);
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].start < anchors[i - 1].end) {
      const mid = (anchors[i - 1].end + anchors[i].start) / 2;
      anchors[i - 1].end = mid;
      anchors[i].start = mid;
    }
  }
  for (const a of anchors) {
    a.start = Math.min(Math.max(0, a.start), D);
    a.end = Math.min(Math.max(a.start + 0.01, a.end), D);
  }

  // Gaps between/around anchors are where the event photos go.
  const regions = [{ start: 0, end: anchors[0].start, after: anchors[0], before: null }];
  for (let i = 1; i < anchors.length; i++) {
    regions.push({ start: anchors[i - 1].end, end: anchors[i].start, before: anchors[i - 1], after: anchors[i] });
  }
  regions.push({ start: anchors[anchors.length - 1].end, end: D, before: anchors[anchors.length - 1], after: null });
  const lens = regions.map((r) => Math.max(0, r.end - r.start));

  // If there's essentially no room for fillers (anchors densely tile [0,D]) but we DO have
  // fillers, fall back to tiling everything evenly (order: event photos first, then anchors)
  // so no image is lost — rare (more entity photos than the narration has room for).
  if (fillers.length && lens.reduce((a, b) => a + b, 0) < 0.5) {
    return tileRange([...fillers, ...anchors], 0, D).map(strip);
  }

  const counts = allocate(fillers.length, lens);
  let fi = 0;
  const placed = [];
  regions.forEach((r, ri) => {
    const c = counts[ri];
    if (c > 0) {
      placed.push(...tileRange(fillers.slice(fi, fi + c), r.start, r.end));
      fi += c;
    } else if (lens[ri] > 0.05) {
      // Empty gap → absorb its time into the adjacent anchor(s) so nothing cuts to black.
      if (r.before && r.after) {
        const mid = (r.start + r.end) / 2;
        r.before.end = mid;
        r.after.start = mid;
      } else if (r.after) {
        r.after.start = r.start; // lead region: the first anchor grows to the top
      } else if (r.before) {
        r.before.end = r.end; // tail region: the last anchor grows to the end
      }
    }
  });

  // Assemble, order by time, then chain-snap for exact contiguous coverage of [0,D].
  const out = [...anchors, ...placed].sort((a, b) => a.start - b.start);
  out[0].start = 0;
  for (let i = 1; i < out.length; i++) out[i].start = out[i - 1].end;
  out[out.length - 1].end = D;
  return out.map(strip);
}

function strip(s) {
  const { _c, _s, _e, ...rest } = s;
  return rest;
}
