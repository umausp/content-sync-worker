// Unit tests for shorts/word_timing.mjs — the dependency-free per-word timing that both
// the image-sync (Gap 1) and bounce-caption (Gap 3) layers build on. Pure, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syllables,
  wordsForSegment,
  wordTimings,
  entitySpokenAt,
} from '../shorts/word_timing.mjs';

test('syllables: floors at 1, drops silent trailing e', () => {
  assert.equal(syllables('the'), 1);
  assert.equal(syllables('cake'), 1); // silent e
  assert.equal(syllables('time'), 1);
  assert.equal(syllables('Christopher'), 3);
  // heuristic proxy (not phonetic truth): 'y' as a vowel merges "aya" → 2 groups. Fine for
  // relative weighting; we only need longer words to outweigh short ones, not exact counts.
  assert.equal(syllables('Zendaya'), 2);
  assert.equal(syllables(''), 1); // never 0
  assert.equal(syllables('123'), 1); // non-alpha → floor
});

test('wordsForSegment: covers the whole window, monotonic, last lands on end', () => {
  const w = wordsForSegment('Zendaya joins Christopher Nolan cast', 2.0, 6.0);
  assert.equal(w.length, 5);
  assert.equal(w[0].start, 2.0); // first starts at segment start
  assert.equal(w[w.length - 1].end, 6.0); // last ends exactly at segment end
  // strictly increasing, contiguous (each start == previous end)
  for (let i = 1; i < w.length; i++) {
    assert.ok(w[i].start >= w[i - 1].start);
    assert.equal(w[i].start, w[i - 1].end);
  }
  // original token preserved verbatim (punctuation intact)
  assert.equal(w[0].word, 'Zendaya');
});

test('wordsForSegment: empty text → no words; single word spans full window', () => {
  assert.deepEqual(wordsForSegment('', 0, 3), []);
  const one = wordsForSegment('Breaking', 1, 4);
  assert.equal(one.length, 1);
  assert.equal(one[0].start, 1);
  assert.equal(one[0].end, 4);
});

test('wordsForSegment: longer/more-syllable words get more time', () => {
  const w = wordsForSegment('a Christopher', 0, 4); // "a"=1 syl, "Christopher"=3 syl+long
  const aDur = w[0].end - w[0].start;
  const cDur = w[1].end - w[1].start;
  assert.ok(cDur > aDur, `"Christopher" (${cDur}) should outlast "a" (${aDur})`);
});

test('wordTimings: flattens sentences, tags sentence index si', () => {
  const segs = [
    { start: 0, end: 2, text: 'Hello world' },
    { start: 2.2, end: 5, text: 'Second sentence here' },
  ];
  const tl = wordTimings(segs);
  assert.equal(tl.length, 5);
  assert.equal(tl[0].si, 0);
  assert.equal(tl[2].si, 1);
  assert.equal(tl[0].start, 0);
  assert.equal(tl[tl.length - 1].end, 5);
});

test('entitySpokenAt: finds a multi-word name as a contiguous run', () => {
  const tl = wordTimings([{ start: 0, end: 6, text: 'Zendaya joins Christopher Nolan cast today' }]);
  const at = entitySpokenAt('Christopher Nolan', tl);
  assert.ok(at, 'should locate the name');
  // spans from "Christopher".start to "Nolan".end
  const chris = tl.find((w) => w.word === 'Christopher');
  const nolan = tl.find((w) => w.word === 'Nolan');
  assert.equal(at.start, chris.start);
  assert.equal(at.end, nolan.end);
});

test('entitySpokenAt: matches despite possessive/punctuation; null when absent', () => {
  const tl = wordTimings([{ start: 0, end: 4, text: "Nolan's new film premieres." }]);
  assert.ok(entitySpokenAt('Nolan', tl), "possessive Nolan's should match nolan");
  assert.equal(entitySpokenAt('Spielberg', tl), null);
  assert.equal(entitySpokenAt('', tl), null);
});
