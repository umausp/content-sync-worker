// Unit tests for shorts/plan_shots.mjs — the image↔word sync planner (Gap 1). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShots } from '../shorts/plan_shots.mjs';
import { wordTimings } from '../shorts/word_timing.mjs';

const evt = (i) => ({ path: `/e${i}.png`, url: `http://x/e${i}.jpg`, kind: 'event' });
const ent = (name, i) => ({ name, url: `http://w/${i}.jpg` });
// helper: entity shot resolved into the `shots` list (as the render passes it — a path + url)
const entShot = (i) => ({ path: `/w${i}.png`, url: `http://w/${i}.jpg`, kind: 'entity' });

function contiguous(out, D) {
  assert.equal(out[0].start, 0, 'starts at 0');
  assert.equal(out[out.length - 1].end, D, 'ends at duration');
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].start >= out[i - 1].start - 1e-9, 'monotonic');
    assert.equal(out[i].start.toFixed(4), out[i - 1].end.toFixed(4), 'contiguous (no gaps/overlap)');
  }
}

test('single image spans the whole duration', () => {
  const out = planShots({ shots: [evt(0)], duration: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 5);
});

test('no entity spoken → even division, order preserved, full coverage', () => {
  const out = planShots({ shots: [evt(0), evt(1), evt(2)], duration: 6, timeline: [] });
  assert.equal(out.length, 3);
  contiguous(out, 6);
  assert.deepEqual(out.map((s) => s.path), ['/e0.png', '/e1.png', '/e2.png']);
  // even thirds
  assert.equal(out[0].end.toFixed(2), '2.00');
  assert.equal(out[1].end.toFixed(2), '4.00');
});

test('entity photo is pinned to the window when its name is spoken', () => {
  const tl = wordTimings([{ start: 0, end: 6, text: 'Zendaya joins Christopher Nolan cast today soon' }]);
  const shots = [evt(0), entShot(1), evt(2)]; // e0, Nolan portrait, e2
  const entityShots = [{ name: 'Christopher Nolan', url: 'http://w/1.jpg' }];
  const out = planShots({ shots, entityShots, timeline: tl, duration: 6 });
  contiguous(out, 6);
  const nolan = out.find((s) => s.url === 'http://w/1.jpg');
  assert.ok(nolan, 'Nolan photo present');
  assert.equal(nolan.kind, 'entity');
  // "Christopher Nolan" is spoken mid-clip → the photo's window straddles that moment.
  const at = { start: tl.find((w) => w.word === 'Christopher').start, end: tl.find((w) => w.word === 'Nolan').end };
  assert.ok(nolan.start <= at.start + 1e-9, 'entity photo up by the time the name starts');
  assert.ok(nolan.end >= at.end - 1e-9, 'entity photo still up when the name finishes');
});

test('every input image appears exactly once', () => {
  const tl = wordTimings([{ start: 0, end: 8, text: 'Modi meets Biden in Delhi for the summit talks now' }]);
  const shots = [evt(0), entShot(1), evt(2), entShot(3)];
  const entityShots = [
    { name: 'Modi', url: 'http://w/1.jpg' },
    { name: 'Biden', url: 'http://w/3.jpg' },
  ];
  const out = planShots({ shots, entityShots, timeline: tl, duration: 8 });
  contiguous(out, 8);
  const urls = out.map((s) => s.url).sort();
  assert.deepEqual(urls, ['http://w/1.jpg', 'http://w/3.jpg', 'http://x/e0.jpg', 'http://x/e2.jpg'].sort());
  assert.equal(out.length, 4);
});

test('two anchors keep spoken order (Modi before Biden)', () => {
  const tl = wordTimings([{ start: 0, end: 8, text: 'Modi meets Biden in Delhi for the summit talks now' }]);
  const shots = [entShot(1), entShot(3), evt(0)];
  const entityShots = [
    { name: 'Modi', url: 'http://w/1.jpg' },
    { name: 'Biden', url: 'http://w/3.jpg' },
  ];
  const out = planShots({ shots, entityShots, timeline: tl, duration: 8 });
  contiguous(out, 8);
  const modiAt = out.find((s) => s.url === 'http://w/1.jpg').start;
  const bidenAt = out.find((s) => s.url === 'http://w/3.jpg').start;
  assert.ok(modiAt < bidenAt, 'Modi shot precedes Biden shot');
});

test('entity whose name is NOT spoken becomes a filler, not an anchor', () => {
  const tl = wordTimings([{ start: 0, end: 4, text: 'A quiet local council meeting was held' }]);
  const shots = [evt(0), entShot(1)]; // entity 1 = "Spielberg" — not spoken
  const entityShots = [{ name: 'Spielberg', url: 'http://w/1.jpg' }];
  const out = planShots({ shots, entityShots, timeline: tl, duration: 4 });
  contiguous(out, 4);
  assert.equal(out.length, 2);
  // no anchor pinning → even halves, order preserved
  assert.equal(out[0].end.toFixed(2), '2.00');
});

test('degrades to even division when timeline is empty even with entityShots', () => {
  const shots = [evt(0), entShot(1)];
  const entityShots = [{ name: 'Nolan', url: 'http://w/1.jpg' }];
  const out = planShots({ shots, entityShots, timeline: [], duration: 4 });
  contiguous(out, 4);
  assert.equal(out.length, 2);
});
