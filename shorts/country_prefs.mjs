// country_prefs.mjs — per-COUNTRY audience category preferences for Shorts SELECTION.
//
// User: "figure out a way to pick interesting news, research what kinds of videos each
// country likes most, then add weight on what kinds of news we create at least once;
// always mind the dedup; if entertainment/sports/politics comes first, find the latest
// trending news." This module is that weighting.
//
// The rankings below are research-derived (Reuters Institute Digital News Report 2023-24
// topic-interest signals + Statista/viewership figures + YouTube Culture & Trends), mapped
// onto the SAME coarse buckets classifyTopic() (video_ledger.mjs) already assigns:
//   football, cricket, tennis, sports-other, politics, conflict, crime, business, tech,
//   entertainment, science, health, weather, general
// (sports-other = the country-specific obsessions the vocabulary collapses: NFL/NBA for the
// US, winter sports/handball for the Nordics, cycling/rugby for FR, baseball/sumo for JP…)
//
// This is a GENTLE tiered NUDGE, never a hard filter:
//   • It never promotes a zero-image story ahead of one with a photo (no "blue screen").
//   • Trend HEAT still decides among equally-preferred stories.
//   • It runs BEFORE the dedup stack (filterAlreadyMade → recent-topic cooldown → cross-run
//     claim) in main(), so the topic-cooldown can still rotate away from a just-aired
//     preferred topic — preference biases the pool, dedup gets the final say ("mind the dedup").
//
// Override any channel's list via env  PREF_<ID>='football,politics,tech'  (comma-separated,
// lowercased bucket names). SHORTS_PREFS=0 disables the whole nudge (rank → image order only).

import { classifyTopic } from './video_ledger.mjs';

// Most-preferred first. Only the channels whose gather flows through the SINGLE lead ranker
// (world + the native channels) are listed; bharat has its own category-diverse slate path
// and never calls this. Unknown channel → [] → the ranker degrades to pure image ordering.
const DEFAULT_PREFS = {
  // World / English (US + UK tier-1): global YouTube skews entertainment + tech; football
  // (soccer) for the UK/global slice, US sports land in sports-other (NFL/NBA).
  world: ['entertainment', 'sports-other', 'tech', 'football', 'politics', 'science'],
  // Germany: Bundesliga + national team dominate; handball/biathlon → sports-other; strong
  // political-news and industrial-business appetite.
  de: ['football', 'politics', 'sports-other', 'business', 'tech', 'health'],
  // Netherlands: football #1; speed-skating/field-hockey/cycling → sports-other; pragmatic
  // politics/business interest.
  nl: ['football', 'sports-other', 'politics', 'business', 'tech', 'health'],
  // France: football leads, but Tour de France (cycling) + rugby lift sports-other; Roland
  // Garros = tennis; deep cinema/culture appetite = entertainment.
  fr: ['football', 'sports-other', 'entertainment', 'politics', 'tennis', 'science'],
  // Japan: anime/gaming/music power entertainment; baseball + sumo = sports-other; deep
  // tech/gadget culture; high science interest.
  jp: ['entertainment', 'sports-other', 'tech', 'science', 'business', 'general'],
  // Sweden: football + ice-hockey/handball/cross-country skiing (sports-other); high
  // climate/environment = science interest.
  sv: ['football', 'sports-other', 'politics', 'science', 'business', 'health'],
  // Norway: winter sports (cross-country/biathlon/alpine) top viewership as sports-other;
  // football strong; high climate/science interest.
  no: ['sports-other', 'football', 'science', 'politics', 'business', 'health'],
  // Denmark: football + handball/cycling/sailing (sports-other); climate-performance nation
  // lifts science; engaged political-news audience.
  da: ['football', 'sports-other', 'politics', 'science', 'business', 'health'],
};

// The user's "hot but stale-prone" buckets: entertainment, ALL sports, and politics. When
// the lead lands in one of these we re-pick the FRESHEST genuinely-trending member of the
// SAME bucket, so a hot category always leads with the latest development, not a stale
// editorial slot (user: "if entertainment/sports/politics comes first, find latest trending").
export const HOT_CATEGORIES = new Set([
  'entertainment', 'football', 'cricket', 'tennis', 'sports-other', 'politics',
]);

// The channel's preferred bucket list (env override → default → []).
export function channelPrefs(cfg) {
  const env = process.env[`PREF_${String(cfg?.id || '').toUpperCase()}`];
  if (env) return env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return DEFAULT_PREFS[cfg?.id] || [];
}

const distinctImages = (s) => new Set([s?.imageUrl, ...(s?.images || [])].filter(Boolean)).size;
const topicOf = (s) => (s.topic = s.topic || classifyTopic(s));

// When the lead is a HOT category, swap in the freshest genuinely-trending story of the SAME
// bucket (a real trend signal — search traffic / a TRENDING badge — first, then the freshest
// by publish age). Only considers same-topic stories that HAVE an image (never blue-screens).
// Deterministic; stable ties keep incoming heat order. Returns a new array (or the input).
function preferLatestInHotCategory(ranked, cfg) {
  if (!Array.isArray(ranked) || ranked.length < 2) return ranked;
  const lead = ranked[0];
  const topic = topicOf(lead);
  if (!HOT_CATEGORIES.has(topic)) return ranked;
  const sameTopic = ranked.filter((s) => distinctImages(s) > 0 && topicOf(s) === topic);
  if (sameTopic.length < 2) return ranked; // nothing fresher of this topic to swap in
  const trendSig = (s) => ((Number(s.traffic) || 0) > 0 || /trend/i.test(`${s.badge || ''} ${s.slot || ''}`) ? 1 : 0);
  const freshOf = (s) => (Number.isFinite(s.freshH) ? s.freshH : 99);
  const best = [...sameTopic].sort(
    (a, b) => trendSig(b) - trendSig(a) || (Number(b.traffic) || 0) - (Number(a.traffic) || 0) || freshOf(a) - freshOf(b),
  )[0];
  if (best && best !== lead) {
    console.log(
      `[prefs:${cfg?.id}] hot category '${topic}' → leading with latest trending: "${String(best.title || '').slice(0, 60)}"`,
    );
    return [best, ...ranked.filter((s) => s !== best)];
  }
  return ranked;
}

// Rank a SINGLE-story candidate pool for this channel. Stable, drops NOTHING (the channel
// must never blank). Tiers, best first:
//   TIER 0 — has ≥1 image           (blue-screen floor — a zero-image lead renders the blank
//                                     brand gradient; a photo'd story always outranks it)
//   TIER 1 — preferred category     (NEW: the research-weighted audience taste for this country)
//   TIER 2 — image-rich (≥ floor)   (a real photo sequence beats a single frame)
//   TIER 3 — incoming order         (trend HEAT — set by the trend sources upstream)
// then the hot-category "latest trending" refresh. With an empty pref list (or SHORTS_PREFS=0)
// TIER 1 is a no-op and this degrades to the prior image-richness ordering exactly.
export function rankForChannel(stories, cfg) {
  if (!Array.isArray(stories) || stories.length < 2) return stories || [];
  if (process.env.SHORTS_PREFS === '0') return stories;
  const prefs = channelPrefs(cfg);
  const floor = Number(process.env.SHORTS_IMG_LEAD_FLOOR || 3);
  const idx = new Map(stories.map((s, i) => [s, i]));
  const ranked = [...stories].sort((a, b) => {
    const na = distinctImages(a);
    const nb = distinctImages(b);
    const ha = na > 0 ? 1 : 0;
    const hb = nb > 0 ? 1 : 0;
    if (ha !== hb) return hb - ha; // TIER 0 — never blue-screen
    const pa = prefs.includes(topicOf(a)) ? 1 : 0;
    const pb = prefs.includes(topicOf(b)) ? 1 : 0;
    if (pa !== pb) return pb - pa; // TIER 1 — preferred category leads
    const ra = na >= floor ? 1 : 0;
    const rb = nb >= floor ? 1 : 0;
    if (ra !== rb) return rb - ra; // TIER 2 — image-rich leads
    return idx.get(a) - idx.get(b); // TIER 3 — trend heat (stable)
  });
  // "Create a preferred category at least once": surface whether one actually leads, so a
  // pool that carried none is VISIBLE in the log rather than silently ignored.
  if (prefs.length) {
    const hasPreferred = ranked.some((s) => distinctImages(s) > 0 && prefs.includes(topicOf(s)));
    if (!hasPreferred) {
      console.log(`[prefs:${cfg?.id}] no preferred-category story in pool (want: ${prefs.join('/')}) — leading with hottest available`);
    } else {
      const lt = topicOf(ranked[0]);
      console.log(`[prefs:${cfg?.id}] lead topic '${lt}' (${prefs.includes(lt) ? 'preferred' : 'not preferred — no photo’d preferred story'}); prefs=${prefs.join('/')}`);
    }
  }
  return preferLatestInHotCategory(ranked, cfg);
}
