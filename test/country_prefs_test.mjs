// Unit tests for country_prefs.mjs — the per-country SINGLE-Short lead ranker. Pure, no
// network, no Redis (classifyTopic is keyword-based). Guards the invariants that matter:
//   • never leads with a zero-image story when a photo'd one exists (no "blue screen")
//   • preferred category leads among equally-illustrated stories
//   • a hot category (entertainment/sports/politics) refreshes to the latest trend
//   • drops NOTHING; degrades to image-only ordering with no prefs / SHORTS_PREFS=0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankForChannel, channelPrefs, HOT_CATEGORIES } from '../shorts/country_prefs.mjs';

// Helper: a story whose classifyTopic() bucket is forced by keywords in the title.
const story = (title, { images = 1, traffic = 0, freshH = 5, badge = '' } = {}) => ({
  title,
  summary: title,
  imageUrl: images > 0 ? 'http://x/0.jpg' : null,
  images: Array.from({ length: Math.max(0, images - 1) }, (_, i) => `http://x/${i + 1}.jpg`),
  traffic,
  freshH,
  badge,
});

const cfg = (id) => ({ id });

test('preferred category leads among equally-illustrated stories (JP → entertainment)', () => {
  const pool = [
    story('Parliament passes new policy vote', { images: 1 }), // politics — not JP-preferred
    story('Netflix film premiere draws celebrity crowd', { images: 1 }), // entertainment — JP #1
  ];
  const out = rankForChannel(pool, cfg('jp'));
  assert.match(out[0].title, /Netflix film premiere/);
  assert.equal(out.length, 2); // drops nothing
});

test('never leads with a zero-image story even if it is a preferred category', () => {
  const pool = [
    story('Netflix film premiere draws celebrity crowd', { images: 0 }), // preferred but NO image
    story('Company reports record quarterly revenue and profit', { images: 2 }), // business, has images
  ];
  const out = rankForChannel(pool, cfg('jp'));
  assert.match(out[0].title, /record quarterly revenue/); // image floor beats preference
});

test('image-rich beats single-frame when neither is a preferred category (world)', () => {
  const pool = [
    story('Local weather storm warning issued', { images: 1 }), // weather — not world-preferred
    story('Earthquake tornado flood hits coastal region', { images: 5 }), // weather — image-rich
  ];
  const out = rankForChannel(pool, cfg('world'));
  assert.match(out[0].title, /Earthquake tornado flood/);
});

test('hot category (politics) refreshes to the latest genuinely-trending same-topic story', () => {
  const pool = [
    // lead: politics, has image, but STALE and no trend signal
    story('Minister announces new government policy', { images: 3, freshH: 40, traffic: 0 }),
    // fresher, trending politics story of the same bucket
    story('Senate election campaign vote surges', { images: 2, freshH: 2, traffic: 50000, badge: 'TRENDING' }),
  ];
  const out = rankForChannel(pool, cfg('de'));
  assert.match(out[0].title, /Senate election campaign/); // swapped in the latest trend
  assert.equal(out.length, 2);
});

test('hot-category refresh never picks a zero-image same-topic story', () => {
  const pool = [
    story('Minister announces new government policy', { images: 3, freshH: 40, traffic: 0 }),
    story('Election vote breaking now', { images: 0, freshH: 1, traffic: 90000, badge: 'TRENDING' }), // trendier but NO image
  ];
  const out = rankForChannel(pool, cfg('de'));
  assert.match(out[0].title, /Minister announces/); // keeps the photo'd lead — no blue screen
});

test('non-hot lead category is not refreshed (tech is not in HOT_CATEGORIES)', () => {
  assert.equal(HOT_CATEGORIES.has('tech'), false);
  const pool = [
    story('New AI chip from Apple boosts iPhone', { images: 2, freshH: 30, traffic: 0 }),
    story('OpenAI software robot gadget launch', { images: 2, freshH: 1, traffic: 80000, badge: 'TRENDING' }),
  ];
  const out = rankForChannel(pool, cfg('jp'));
  assert.match(out[0].title, /New AI chip from Apple/); // stable — tech lead not swapped
});

test('SHORTS_PREFS=0 disables the nudge (returns input unchanged)', () => {
  const prev = process.env.SHORTS_PREFS;
  process.env.SHORTS_PREFS = '0';
  const pool = [
    story('Parliament passes new policy vote', { images: 1 }),
    story('Netflix film premiere draws celebrity crowd', { images: 1 }),
  ];
  const out = rankForChannel(pool, cfg('jp'));
  assert.match(out[0].title, /Parliament passes/); // untouched original order
  if (prev === undefined) delete process.env.SHORTS_PREFS;
  else process.env.SHORTS_PREFS = prev;
});

test('unknown channel with no prefs degrades to image ordering, drops nothing', () => {
  const pool = [
    story('Some generic story', { images: 0 }),
    story('Another generic story', { images: 3 }),
    story('Third generic story', { images: 1 }),
  ];
  const out = rankForChannel(pool, cfg('zz'));
  assert.equal(out.length, 3);
  assert.match(out[0].title, /Another generic story/); // most images leads
  assert.equal(out[2].title, 'Some generic story'); // zero-image last
});

test('env override PREF_<ID> replaces the default list', () => {
  const prev = process.env.PREF_WORLD;
  process.env.PREF_WORLD = 'weather';
  const pool = [
    story('Netflix film premiere draws celebrity crowd', { images: 1 }), // entertainment
    story('Hurricane storm flood warning', { images: 1 }), // weather — now the only preferred
  ];
  assert.deepEqual(channelPrefs(cfg('world')), ['weather']);
  const out = rankForChannel(pool, cfg('world'));
  assert.match(out[0].title, /Hurricane storm flood/);
  if (prev === undefined) delete process.env.PREF_WORLD;
  else process.env.PREF_WORLD = prev;
});

test('single-element and empty pools pass through untouched', () => {
  assert.deepEqual(rankForChannel([], cfg('world')), []);
  const one = [story('Only story', { images: 0 })];
  assert.equal(rankForChannel(one, cfg('world')).length, 1);
});
