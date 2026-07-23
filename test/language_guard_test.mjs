// Unit tests for looksNonEnglish (shorts/world_feeds.mjs) — the World-channel language
// guard. Regression for the "foreign stories on the English channel" bug: the old detector
// only knew LATIN-script foreign languages (German/French/Spanish function words + accents),
// so non-Latin scripts (Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, Greek, Thai,
// Devanagari…) sailed through untranslated onto the English channel. One such clip is a
// reputation risk, so ANY non-Latin character must flag the text as foreign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksNonEnglish } from '../shorts/world_feeds.mjs';

test('English (incl. proper nouns, acronyms, numbers) is NOT flagged', () => {
  for (const t of [
    'English headline about the economy',
    'Apple unveils iPhone 17 in California',
    'ISRO launches PSLV-C60 mission successfully',
    'Zendaya and Tom Holland at the 2025 premiere',
    '2025 Q3 GDP up 3.4%',
  ]) {
    assert.equal(looksNonEnglish(t), false, `should be English: ${t}`);
  }
});

test('a single accented proper noun stays English (no false positive)', () => {
  assert.equal(looksNonEnglish('Beyoncé wins big at the Grammys'), false);
  assert.equal(looksNonEnglish('Chloé Zhao directs the new film'), false);
});

test('Latin-script foreign languages are flagged (function words / accents)', () => {
  assert.equal(looksNonEnglish('Der Bundeskanzler spricht heute'), true); // German
  assert.equal(looksNonEnglish('Macron annonce une réforme majeure'), true); // French
  assert.equal(looksNonEnglish('El presidente firma una nueva ley'), true); // Spanish
});

test('NON-LATIN scripts are ALL flagged (the reputation-critical leak)', () => {
  assert.equal(looksNonEnglish('中国宣布新的经济政策'), true); // Chinese
  assert.equal(looksNonEnglish('日本の首相が辞任を発表'), true); // Japanese
  assert.equal(looksNonEnglish('한국 대통령이 새 정책 발표'), true); // Korean
  assert.equal(looksNonEnglish('Президент подписал новый закон'), true); // Russian/Cyrillic
  assert.equal(looksNonEnglish('الرئيس يعلن عن قرار جديد'), true); // Arabic
  assert.equal(looksNonEnglish('נשיא ישראל נואם היום'), true); // Hebrew
  assert.equal(looksNonEnglish('Ο πρωθυπουργός ανακοίνωσε'), true); // Greek
  assert.equal(looksNonEnglish('นายกรัฐมนตรีประกาศนโยบายใหม่'), true); // Thai
  assert.equal(looksNonEnglish('प्रधानमंत्री ने नई नीति की घोषणा की'), true); // Devanagari
});

test('a single foreign character in an otherwise-English string still flags', () => {
  // Mixed-script headlines (a foreign name/quote spliced in) must not slip through.
  assert.equal(looksNonEnglish('Protesters chant 自由 in the streets'), true);
});

test('empty / whitespace is not flagged', () => {
  assert.equal(looksNonEnglish(''), false);
  assert.equal(looksNonEnglish('   '), false);
  assert.equal(looksNonEnglish(null), false);
});
