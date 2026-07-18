# content-sync-worker

Scheduled content aggregation + summarization pipeline. Fetches public RSS
sources, groups related items, ranks by cross-source frequency, summarizes with
a local model on the runner, and posts results to a configured HTTPS endpoint.

Runs entirely on the CI runner — no external servers.

Sources: curated public RSS feeds, plus an optional global-firehose source for
extra cross-source coverage (see below).

## Configuration (repository secrets)

| Secret | Required? | Purpose |
|---|---|---|
| `INGEST_URL` | yes | HTTPS endpoint that accepts summarized items |
| `STORIES_URL` | yes | HTTPS endpoint for the dedup/update reference list |
| `NEWS_INGEST_TOKEN` | yes | Bearer token for the ingest endpoint |
| `GROQ_API_KEY` | optional | Free-tier hosted inference (primary — fast) |
| `GEMINI_API_KEY` | optional | Free-tier hosted inference (fallback) |
| `CF_ACCOUNT_ID` + `CF_AI_TOKEN` | optional | Cloudflare Workers AI (spillover — capped) |

### Synthesis providers ($0)

Summarization routes through a provider ladder (`src/providers.mjs`):
**Groq → Gemini → Cloudflare Workers AI → local Ollama**. Each is skipped if its
key is absent; add any subset. All run on FREE tiers — most just rate-limit (429)
when exhausted with no bill. **Cloudflare is the only one that bills past its free
neuron allowance**, so it sits LAST in the ladder and has a hard per-run cap
(`CF_DAILY_CAP`, default 150) — it only ever handles spillover, guaranteeing $0.
If every provider is exhausted/unkeyed, the pipeline falls back to **extractive
summaries** (no LLM, instant, hallucination-proof) so no story is ever dropped and
no paid call is ever made. Hosted inference is fast enough to synthesise the top
~400 events/run (`SYNTH_HOSTED_MAX`) with the tail handled extractively.

## Run

Automatically on a schedule (see `.github/workflows/pipeline.yml`) or manually
via the workflow's "Run workflow" button.

Tunables live in the workflow env: `OLLAMA_MODEL`, `SYNTH_HARD_MAX`,
`SYNTH_BATCH`, `SYNTH_BUDGET_MS`, `MIN_IMPORTANCE`, `PUBLISH_MIN_IMPORTANCE`,
`PUBLISH_MIN_CORROBORATION`, `PER_FEED`.

## Global-firehose source (`src/gdelt/`)

An optional extra source that widens cross-source coverage — more independent
publishers covering the same event raise its corroboration/importance signal.
Best-effort and self-contained (no extra secrets, no paid tier); if it's
unavailable a run proceeds on the primary feeds alone.

Two surfaces with automatic fallback:
1. **API** (primary) — real headlines + images in one request; rate-limited per
   IP, so it uses patient exponential backoff.
2. **Raw file** (fallback) — an unthrottled CDN; titles derived from URL slugs.
   Dependency-free ZIP inflate (no `unzip` needed); handles the HTTP-only host
   and the newest-file publish lag.

Env knobs: `GDELT_ENABLED` (`1`/`0`), `GDELT_QUERY`, `GDELT_MAX`,
`GDELT_TIMESPAN`. Set `GDELT_FORCE_GKG=1` to skip the API and test the fallback.
