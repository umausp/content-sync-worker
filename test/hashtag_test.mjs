// Unit tests for makeHashtag (shorts/world_feeds.mjs) — the #Hashtag builder used by both
// slotHashtag (editorial) and trendTag (trends). Pure, no network. Regression guard for the
// "#JackieBald" glue bug: the old code joined the first two proper nouns found ANYWHERE in a
// title, inventing phrases from non-adjacent words. makeHashtag only joins a CONTIGUOUS run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHashtag } from '../shorts/world_feeds.mjs';

test('never glues NON-ADJACENT proper nouns (the #JackieBald bug)', () => {
  // "Jackie" and "Bald" are not adjacent → must NOT become #JackieBald.
  assert.equal(makeHashtag('Actor Jackie goes Bald for his new movie role'), 'Jackie');
  assert.equal(makeHashtag('Elon Musk buys Twitter for billions'), 'ElonMusk'); // adjacent → ok
});

test('keeps a lead entity (no mid-sentence-only filter dropping it)', () => {
  assert.equal(makeHashtag('Jackie Chan announces new film'), 'JackieChan'); // was #Chan
  assert.equal(makeHashtag('India defeats Australia in cricket final'), 'India'); // was #Australia
});

test('preserves all-caps acronyms', () => {
  assert.equal(makeHashtag('ISRO successfully launches new satellite'), 'ISRO');
  assert.equal(makeHashtag('NASA and SpaceX plan joint mission'), 'NASA');
});

test('joins a contiguous multi-word entity, capped at 2 words', () => {
  assert.equal(makeHashtag('New York braces for storm'), 'NewYork');
  // 3-word run capped to first 2.
  assert.equal(makeHashtag('United States Congress passes bill'), 'UnitedStates');
});

test('skips leading article, keeps the title', () => {
  assert.equal(makeHashtag('The Odyssey trailer drops'), 'Odyssey');
});

test('falls back to strongest keyword when no proper noun', () => {
  assert.equal(makeHashtag('stock market crashes today'), 'StockMarket');
});

test('uses the fallback when nothing usable', () => {
  assert.equal(makeHashtag('', 'News'), 'News');
  assert.equal(makeHashtag('the and for', 'Trending'), 'Trending');
});

test('drops role/descriptor lead-words (Actor/Star/President…)', () => {
  assert.equal(makeHashtag('President Biden signs order'), 'Biden');
  assert.equal(makeHashtag('Star Zendaya wins award'), 'Zendaya');
});

test('output is clean: alphanumeric only, ≤24 chars', () => {
  const tag = makeHashtag("Rodri's Spain lift the trophy!");
  assert.match(tag, /^[A-Za-z0-9]+$/);
  assert.ok(tag.length <= 24);
});
