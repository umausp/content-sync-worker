// native_feeds.mjs — per-language NATIVE sourcing for the non-English @AgyataWorld channels
// (DE / NL / FR / JP / SV / NO / DA). Each of these channels ships videos IN ITS OWN LANGUAGE
// with NO translation: native RSS roundup + native Google-Trends + native X-trends, all synth-
// ed and captioned in that language. This is the native mirror of world_feeds.mjs's English
// three-source gather (buildWorldRoundup + buildTrendingStories + buildXTrendingStories) — it
// reuses those SAME builders (now parameterized by `slots`/`geos`/`lang`) so there is ONE
// gather engine, not seven copies.
//
// Every feed URL + Google-News locale + trends24 slug below was verified reachable via Node
// fetch (native-language content, >3 items) before wiring. Pure RSS + public trend boards +
// free-tier LLM synth — $0, no keys.

import { buildWorldRoundup, buildTrendingStories, buildXTrendingStories } from './world_feeds.mjs';

// ── PER-LANGUAGE SLOT ROSTERS ────────────────────────────────────────────────────────────
// Same 9-ish editorial slots as WORLD_SLOTS (politics/breaking/global/entertainment/tech/
// science/sports/health/offbeat) but pointed at each country's OWN major public-broadcaster +
// quality-press feeds. Slot `label` is the on-screen badge, localized per language. Not every
// outlet splits every category, so some slots share a broad feed — the round-robin interleave
// + cross-slot dedup in buildWorldRoundup handle overlap.

// GERMAN (de) — tagesschau (ARD), Der Spiegel sections, Deutsche Welle.
const DE_SLOTS = [
  { key: 'politics', label: 'POLITIK', feeds: ['https://www.tagesschau.de/index~rss2.xml', 'https://www.spiegel.de/politik/index.rss'] },
  { key: 'breaking', label: 'EILMELDUNG', feeds: ['https://www.tagesschau.de/index~rss2.xml', 'https://rss.dw.com/rdf/rss-de-all'] },
  { key: 'crisis', label: 'WIRTSCHAFT', feeds: ['https://www.spiegel.de/wirtschaft/index.rss'] },
  { key: 'entertainment', label: 'KULTUR', feeds: ['https://www.spiegel.de/kultur/index.rss'] },
  { key: 'tech', label: 'NETZWELT', feeds: ['https://www.spiegel.de/netzwelt/index.rss'] },
  { key: 'facts', label: 'WISSEN', feeds: ['https://www.spiegel.de/wissenschaft/index.rss'] },
  { key: 'sports', label: 'SPORT', feeds: ['https://www.spiegel.de/sport/index.rss'] },
];

// DUTCH (nl) — NOS (public broadcaster) sections + NU.nl.
const NL_SLOTS = [
  { key: 'politics', label: 'POLITIEK', feeds: ['https://feeds.nos.nl/nosnieuwspolitiek'] },
  { key: 'breaking', label: 'NIEUWS', feeds: ['https://feeds.nos.nl/nosnieuwsalgemeen'] },
  { key: 'crisis', label: 'ECONOMIE', feeds: ['https://feeds.nos.nl/nosnieuwseconomie'] },
  { key: 'entertainment', label: 'CULTUUR', feeds: ['https://feeds.nos.nl/nosnieuwscultuurenmedia'] },
  { key: 'tech', label: 'TECH', feeds: ['https://feeds.nos.nl/nosnieuwstech'] },
  { key: 'facts', label: 'WETENSCHAP', feeds: ['https://www.nu.nl/rss/Wetenschap'] },
  { key: 'sports', label: 'SPORT', feeds: ['https://feeds.nos.nl/nossportalgemeen'] },
  { key: 'offbeat', label: 'BUITENLAND', feeds: ['https://feeds.nos.nl/nosnieuwsbuitenland'] },
];

// FRENCH (fr) — Le Monde sections + France 24.
const FR_SLOTS = [
  { key: 'politics', label: 'POLITIQUE', feeds: ['https://www.lemonde.fr/politique/rss_full.xml'] },
  { key: 'breaking', label: 'À LA UNE', feeds: ['https://www.lemonde.fr/rss/une.xml', 'https://www.france24.com/fr/rss'] },
  { key: 'crisis', label: 'ÉCONOMIE', feeds: ['https://www.lemonde.fr/economie/rss_full.xml'] },
  { key: 'entertainment', label: 'CULTURE', feeds: ['https://www.lemonde.fr/culture/rss_full.xml'] },
  { key: 'tech', label: 'PIXELS', feeds: ['https://www.lemonde.fr/pixels/rss_full.xml'] },
  { key: 'facts', label: 'SCIENCES', feeds: ['https://www.lemonde.fr/sciences/rss_full.xml'] },
  { key: 'sports', label: 'SPORT', feeds: ['https://www.lemonde.fr/sport/rss_full.xml'] },
];

// JAPANESE (ja) — NHK category feeds + Asahi Shimbun headlines. cat0=main cat1=society
// cat3=economy cat4=politics cat5=intl cat6=sports cat7=culture.
const JP_SLOTS = [
  { key: 'politics', label: '政治', feeds: ['https://www.nhk.or.jp/rss/news/cat4.xml'] },
  { key: 'breaking', label: 'ニュース', feeds: ['https://www.nhk.or.jp/rss/news/cat0.xml', 'https://www.asahi.com/rss/asahi/newsheadlines.rdf'] },
  { key: 'crisis', label: '経済', feeds: ['https://www.nhk.or.jp/rss/news/cat3.xml'] },
  { key: 'entertainment', label: '文化', feeds: ['https://www.nhk.or.jp/rss/news/cat7.xml'] },
  { key: 'facts', label: '科学', feeds: ['https://www.nhk.or.jp/rss/news/cat3.xml'] },
  { key: 'sports', label: 'スポーツ', feeds: ['https://www.nhk.or.jp/rss/news/cat6.xml'] },
  { key: 'offbeat', label: '国際', feeds: ['https://www.nhk.or.jp/rss/news/cat5.xml'] },
];

// SWEDISH (sv) — SVT (public broadcaster) sections + Dagens Nyheter.
const SV_SLOTS = [
  { key: 'politics', label: 'INRIKES', feeds: ['https://www.svt.se/nyheter/inrikes/rss.xml'] },
  { key: 'breaking', label: 'NYHETER', feeds: ['https://www.svt.se/nyheter/rss.xml'] },
  { key: 'crisis', label: 'EKONOMI', feeds: ['https://www.svt.se/nyheter/ekonomi/rss.xml', 'https://www.dn.se/ekonomi/rss'] },
  { key: 'entertainment', label: 'KULTUR', feeds: ['https://www.svt.se/kultur/rss.xml'] },
  { key: 'facts', label: 'VETENSKAP', feeds: ['https://www.svt.se/nyheter/vetenskap/rss.xml'] },
  { key: 'sports', label: 'SPORT', feeds: ['https://www.dn.se/sport/rss'] },
  { key: 'offbeat', label: 'UTRIKES', feeds: ['https://www.svt.se/nyheter/utrikes/rss.xml'] },
];

// NORWEGIAN (no) — NRK (public broadcaster) sections + E24 (business).
const NO_SLOTS = [
  { key: 'politics', label: 'NORGE', feeds: ['https://www.nrk.no/norge/toppsaker.rss'] },
  { key: 'breaking', label: 'NYHETER', feeds: ['https://www.nrk.no/toppsaker.rss', 'https://www.nrk.no/nyheter/siste.rss'] },
  { key: 'crisis', label: 'ØKONOMI', feeds: ['https://e24.no/rss'] },
  { key: 'entertainment', label: 'KULTUR', feeds: ['https://www.nrk.no/kultur/toppsaker.rss'] },
  { key: 'facts', label: 'VITEN', feeds: ['https://www.nrk.no/viten/toppsaker.rss'] },
  { key: 'sports', label: 'SPORT', feeds: ['https://www.nrk.no/sport/toppsaker.rss'] },
  { key: 'offbeat', label: 'URIX', feeds: ['https://www.nrk.no/urix/toppsaker.rss'] },
];

// DANISH (da) — DR (public broadcaster) feed service.
const DA_BASE = 'https://www.dr.dk/nyheder/service/feeds';
const DA_SLOTS = [
  { key: 'politics', label: 'POLITIK', feeds: [`${DA_BASE}/politik`] },
  { key: 'breaking', label: 'NYHEDER', feeds: [`${DA_BASE}/allenyheder`, `${DA_BASE}/senestenyt`] },
  { key: 'crisis', label: 'PENGE', feeds: [`${DA_BASE}/penge`] },
  { key: 'entertainment', label: 'KULTUR', feeds: [`${DA_BASE}/kultur`] },
  { key: 'facts', label: 'VIDEN', feeds: [`${DA_BASE}/viden`] },
  { key: 'sports', label: 'SPORT', feeds: [`${DA_BASE}/sporten`] },
  { key: 'offbeat', label: 'UDLAND', feeds: [`${DA_BASE}/udland`] },
];

// ── PER-LANGUAGE GATHER SPEC ─────────────────────────────────────────────────────────────
// slots  = editorial roster above
// geos   = country codes for Google-Trends (ISO 3166) + X-trends (trends24 slug via
//          world_feeds X_GEO_SLUG). One geo per channel — a single-country audience.
// The `lang` on cfg (de/nl/fr/ja/sv/no/da) drives native synth + native Google-News locale +
// the non-Latin trend-filter bypass inside the shared builders.
export const NATIVE_SPECS = {
  de: { slots: DE_SLOTS, geos: ['DE'] },
  nl: { slots: NL_SLOTS, geos: ['NL'] },
  fr: { slots: FR_SLOTS, geos: ['FR'] },
  ja: { slots: JP_SLOTS, geos: ['JP'] },
  sv: { slots: SV_SLOTS, geos: ['SE'] },
  no: { slots: NO_SLOTS, geos: ['NO'] },
  da: { slots: DA_SLOTS, geos: ['DK'] },
};

export function nativeSpec(lang) {
  return NATIVE_SPECS[lang] || null;
}

// Gather a native channel's candidate pool — the native mirror of build_short's world gather.
// Runs the three sources concurrently (each enriches = native multi-outlet synth), returns the
// raw arrays for the caller to merge/dedup/rank exactly like the world path (so ONE merge policy
// governs every channel). `opts` mirrors the world call: { perSlot, perGeoTrends, perGeoX,
//   maxAgeH, xTrends }.
export async function gatherNativeSources(lang, {
  perSlot = 1, perGeoTrends = 1, perGeoX = 1, maxAgeH = 18, xTrends = true, depth = 'normal',
} = {}) {
  const spec = nativeSpec(lang);
  if (!spec) throw new Error(`native_feeds: no spec for lang "${lang}"`);
  const { slots, geos } = spec;
  // `depth` = 'deep' for single-story Shorts → the multi-outlet synth writes a fuller 4-6
  // sentence brief so a one-story clip fills 30-45s (see world_feeds DEPTH_SPEC).
  const [round, gtrends, xtrends] = await Promise.all([
    buildWorldRoundup({ slots, lang, maxAgeH, perSlot, enrich: true, depth }).catch((e) => {
      console.log(`[native:${lang}] roundup failed: ${e.message}`);
      return [];
    }),
    buildTrendingStories({ geos, lang, perGeo: perGeoTrends, enrich: true, depth }).catch((e) => {
      console.log(`[native:${lang}] google-trends failed: ${e.message}`);
      return [];
    }),
    xTrends
      ? buildXTrendingStories({ geos, lang, perGeo: perGeoX, enrich: true, depth }).catch((e) => {
          console.log(`[native:${lang}] x-trends failed: ${e.message}`);
          return [];
        })
      : Promise.resolve([]),
  ]);
  console.log(`[native:${lang}] raw: editorial=${round.length} google-trends=${gtrends.length} x-trends=${xtrends.length} (geos=${geos.join(',')})`);
  return { round, gtrends, xtrends };
}
