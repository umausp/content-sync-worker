// research.mjs — the DEDICATED RESEARCH POOL for the @AgyataWorld channel.
//
//   node shorts/research.mjs [usa europe]
//
// Runs on its OWN GitHub Actions workflow (research-world.yml) with a GENEROUS timeout,
// DECOUPLED from the render (user: "shorts world and longform should have dedicated
// research pool on github actions without timeout"). It does the heavy, slow work ONCE —
// deep trend discovery + multi-outlet extraction + LLM synthesis + verification — and
// writes a rich JSON bundle to docs/research/. The render workflows then just READ the
// freshest bundle and turn it into video (fast, reliable), falling back to live research
// only if no fresh bundle exists.
//
// PIPELINE (user's steps + more):
//   1. TRENDS   — X trending board + Google Trends RSS, per region geo (buildTrending*).
//   2. TRIAGE   — keep only real-news terms; fandom/meme/utility junk is filtered
//                 (xTermUsable / X_JUNK) and ad/brand pages never survive the gates.
//   3. GATHER   — each hot term → Google News search → MANY latest publisher articles.
//   4. CLUSTER  — same-event articles grouped (normTitle); corroboration counted.
//   5. EXTRACT  — for EVERY outlet on a story (BBC + NYT + …), pull clean prose + the
//                 publisher's OWN photos (src/extract.mjs, ad-filtered). ALL sources'
//                 images are collected (user: "if BBC, New York Times etc have published
//                 same news then fetch all the images"). — done inside enrichSummary.
//   6. SYNTH    — ONE corroborated, non-repetitive brief per story via the NVIDIA→…→Ollama
//                 ladder (huggingface in the middle). — done inside enrichSummary.
//   7. VERIFY   — drop stories without a real image or a brief that genuinely grew past
//                 the headline; flag verified = corroborated by ≥2 outlets.
//   8. DEDUP    — cross-source + cross-region dedup by normalized title.
//   9. BUNDLE   — write docs/research/world-<region>.json: every category with multiple
//                 researched stories {title, summary, images[], sources[], hashtag, …}.
//
// $0: pure RSS + public trend boards + free-tier LLMs + local Ollama. No paid services.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWorldRoundup, buildTrendingStories, buildXTrendingStories } from './world_feeds.mjs';
import { availableProviders } from '../src/providers.mjs';

// Region → trend geos (same env vars build_short.mjs uses, so the two agree). A USA run
// pulls US trends; a Europe run rotates the European country list so "all countries" get
// covered across successive runs.
const US_GEOS = (process.env.WORLD_US_GEOS || 'US').split(',').map((g) => g.trim()).filter(Boolean);
const EU_GEOS = (process.env.WORLD_EU_GEOS || 'GB,IE,DE,FR,IT,ES,NL').split(',').map((g) => g.trim()).filter(Boolean);
function regionGeos(region) {
  return region === 'usa' ? US_GEOS : EU_GEOS;
}

// How DEEP to research (this is the timeout-free pool, so go wide — the render only ever
// reads a slice). Env-overridable per run.
const PER_SLOT = Number(process.env.RESEARCH_PER_SLOT || 3); // editorial stories per category
const PER_GEO_TRENDS = Number(process.env.RESEARCH_PER_GEO_TRENDS || 5); // Google-Trends stories/geo
const PER_GEO_X = Number(process.env.RESEARCH_PER_GEO_X || 5); // X-trend stories/geo
const MAX_AGE_H = Number(process.env.RESEARCH_MAX_AGE_H || 18); // freshness window for editorial

// Normalized title key — MUST match build_short.mjs / world_feeds.mjs so dedup + the
// render's cross-run claim all agree on what "the same story" is.
function normKey(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 8)
    .join(' ');
}

// Deep-research ONE region: gather from all three sources (each already enriches = the
// heavy multi-outlet extraction + LLM synth), merge, cross-dedup. Returns a ranked,
// verified candidate list of enriched story objects.
async function researchRegion(region) {
  const geos = regionGeos(region);
  console.log(`[research:${region}] geos=${geos.join(',')} — gathering (editorial + Google Trends + X)…`);

  // Run the three sources concurrently; each fails open to [] so one dead source never
  // sinks the run. buildWorldRoundup is global editorial; the two trend sources are the
  // region signal. enrich:true does the per-story multi-outlet research inside each.
  const [round, gtrends, xtrends] = await Promise.all([
    buildWorldRoundup({ maxAgeH: MAX_AGE_H, perSlot: PER_SLOT, enrich: true }).catch((e) => {
      console.log(`[research:${region}] editorial roundup failed: ${e.message}`);
      return [];
    }),
    buildTrendingStories({ geos, perGeo: PER_GEO_TRENDS, enrich: true }).catch((e) => {
      console.log(`[research:${region}] google-trends failed: ${e.message}`);
      return [];
    }),
    process.env.WORLD_X_TRENDS === '0'
      ? Promise.resolve([])
      : buildXTrendingStories({ geos, perGeo: PER_GEO_X, enrich: true }).catch((e) => {
          console.log(`[research:${region}] x-trends failed: ${e.message}`);
          return [];
        }),
  ]);
  console.log(`[research:${region}] raw: editorial=${round.length} google-trends=${gtrends.length} x-trends=${xtrends.length}`);

  // MERGE — trending first (freshest social pulse), then editorial fills the categories.
  // Cross-dedup by normalized title so the SAME event from two sources counts once, and
  // keep the version with the richer body / more sources.
  const byKey = new Map();
  const consider = [...xtrends, ...gtrends, ...round];
  for (const s of consider) {
    if (!s || !s.title) continue;
    const k = normKey(s.title);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, s);
      continue;
    }
    // Keep whichever is the stronger research artifact: more source outlets, then a
    // longer (more substantial) synthesised brief.
    const score = (x) => (x.sources?.length || 0) * 1000 + (x.summary?.length || 0);
    if (score(s) > score(prev)) {
      // preserve the union of source URLs + images so we don't lose any outlet's photos
      s.sourceUrls = [...new Set([...(s.sourceUrls || []), ...(prev.sourceUrls || [])])].slice(0, 8);
      s.images = [...new Set([...(s.images || []), ...(prev.images || [])])].slice(0, 12);
      s.sources = [...new Set([...(s.sources || []), ...(prev.sources || [])])];
      byKey.set(k, s);
    }
  }
  const merged = [...byKey.values()];

  // VERIFY — a researched story must have a real image AND a brief that genuinely grew
  // past the headline (kills JS-rendered pages that echo the title back / thin sources).
  // verified = corroborated by ≥2 distinct outlets (the render can prefer these).
  const verified = merged
    .map((s) => {
      const grew = (s.summary || '').trim().length - (s.title || '').trim().length;
      const hasImg = !!(s.imageUrl || (s.images && s.images.length));
      const realBrief = (s.summary || '').length > 120 && grew > 40 && /[.!?]$/.test((s.summary || '').trim());
      const corr = s.corr || (s.sources ? s.sources.length : 0);
      return { ...s, verified: corr >= 2, _ok: hasImg && realBrief, _corr: corr };
    })
    .filter((s) => s._ok);

  // RANK — corroborated + more images + more source outlets first (a bigger, more real
  // story with more genuine photos leads). Trend heat breaks ties.
  verified.sort((a, b) => {
    const score = (x) =>
      (x.verified ? 3 : 0) + (x._corr || 0) + Math.min(6, (x.images?.length || 0)) + (x.traffic ? 1 : 0);
    return score(b) - score(a) || (b.traffic || 0) - (a.traffic || 0);
  });

  console.log(`[research:${region}] verified ${verified.length}/${merged.length} stories (${verified.filter((s) => s.verified).length} corroborated ≥2 outlets)`);
  return verified;
}

// Group a region's stories by category into the bundle shape the render + humans read.
function groupByCategory(stories) {
  const categories = {};
  for (const s of stories) {
    const cat = s.category || s.slot || 'top';
    (categories[cat] ||= []).push(s);
  }
  return categories;
}

// Trim a story to just what the render + a human reviewer need (drop internal scratch
// fields). Keeps ALL sources' image URLs + article URLs so the render can build a genuine
// multi-photo sequence and credit every outlet.
function slimStory(s) {
  return {
    title: s.title,
    summary: s.summary,
    hashtag: s.hashtag,
    badge: s.badge,
    category: s.category || s.slot || 'top',
    url: s.url,
    imageUrl: s.imageUrl || (s.images && s.images[0]) || null,
    images: (s.images || []).slice(0, 12),
    sourceUrls: (s.sourceUrls || []).slice(0, 8),
    sourceName: s.sourceName || null,
    sources: s.sources || [],
    corr: s._corr || s.corr || 0,
    verified: !!s.verified,
    trend: s.trend || null,
    traffic: s.traffic || 0,
    region: s.region || null,
    geo: s.geo || null,
  };
}

async function main() {
  const argv = process.argv.slice(2).map((a) => a.toLowerCase().trim()).filter(Boolean);
  const regions = argv.length ? argv : (process.env.RESEARCH_REGIONS || 'usa,europe').split(',').map((r) => r.trim()).filter(Boolean);
  const stamp = new Date().toISOString();
  console.log(`[research] pool start ${stamp} — regions=${regions.join(',')} — LLMs=[${availableProviders().join(', ') || 'none'}]`);

  const outDir = join(process.cwd(), 'docs', 'research');
  await mkdir(outDir, { recursive: true });

  for (const region of regions) {
    const stories = await researchRegion(region);
    if (!stories.length) {
      console.log(`[research:${region}] ⚠ produced 0 verified stories — leaving previous bundle in place`);
      continue;
    }
    const slim = stories.map((s) => ({ ...slimStory(s), region }));
    const categories = groupByCategory(slim);
    const bundle = {
      generatedAt: stamp,
      region,
      count: slim.length,
      categoryCounts: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.length])),
      // Flat ranked list the render reads directly as its candidate pool (hottest first).
      stories: slim,
      // Same stories grouped by category — for humans + a future "one video per category".
      categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.map(slimStory)])),
    };
    const path = join(outDir, `world-${region}.json`);
    await writeFile(path, JSON.stringify(bundle, null, 2));
    console.log(`[research:${region}] ✓ wrote ${slim.length} stories across ${Object.keys(categories).length} categories → ${path}`);
    console.log(`[research:${region}]   categories: ${Object.entries(bundle.categoryCounts).map(([k, n]) => `${k}:${n}`).join(' ')}`);
  }
  console.log('[research] pool done');
}

main().catch((e) => {
  console.error(`[research] FAILED: ${e.stack || e.message}`);
  process.exit(1);
});
