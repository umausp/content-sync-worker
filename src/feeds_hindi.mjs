// Hindi regional/local RSS roster for the "Local News" edition. Verified: each
// returns real Devanagari content + parses. Weighted toward DEEP LOCAL coverage
// (state/city desks — UP, Bihar, MP, Rajasthan) which is the point of this feed:
// hyperlocal, informative news the English national feed never surfaces.
// category is the genre used for the editorial quota; 'local' tags the section.

export const FEEDS_HINDI = [
  // ── Dainik Bhaskar ──────────────────────────────────────────────────────
  { url: 'https://www.bhaskar.com/rss-v1--category-1741.xml', category: 'local' },
  // ── Amar Ujala (national + deep state desks) ────────────────────────────
  { url: 'https://www.amarujala.com/rss/india-news.xml', category: 'local' },
  { url: 'https://www.amarujala.com/rss/uttar-pradesh.xml', category: 'local' },
  { url: 'https://www.amarujala.com/rss/bihar.xml', category: 'local' },
  { url: 'https://www.amarujala.com/rss/madhya-pradesh.xml', category: 'local' },
  { url: 'https://www.amarujala.com/rss/rajasthan.xml', category: 'local' },
  // ── News18 Hindi (nation + UP) ──────────────────────────────────────────
  { url: 'https://hindi.news18.com/rss/khabar/nation/nation.xml', category: 'local' },
  { url: 'https://hindi.news18.com/commonfeeds/v1/hin/rss/uttar-pradesh.xml', category: 'local' },
  // ── Aaj Tak ─────────────────────────────────────────────────────────────
  { url: 'https://www.aajtak.in/rssfeeds/?id=home', category: 'local' },
  // ── ABP / Live Hindustan / TV9 ──────────────────────────────────────────
  { url: 'https://www.abplive.com/home/feed', category: 'local' },
  { url: 'https://feed.livehindustan.com/rss/3127', category: 'local' },
  { url: 'https://www.tv9hindi.com/feed', category: 'local' },
];

// Readable outlet names for Hindi domains (used by the pipeline's outlet()).
export const HINDI_OUTLETS = {
  'bhaskar.com': 'Dainik Bhaskar',
  'amarujala.com': 'Amar Ujala',
  'news18.com': 'News18 Hindi',
  'aajtak.in': 'Aaj Tak',
  'abplive.com': 'ABP News',
  'livehindustan.com': 'Hindustan',
  'tv9hindi.com': 'TV9 Bharatvarsh',
  'jagran.com': 'Dainik Jagran',
  'patrika.com': 'Patrika',
};
