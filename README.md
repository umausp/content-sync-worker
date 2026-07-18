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
| `CEREBRAS_API_KEY` | optional | Free, very fast — primary synthesis |
| `GEMINI_API_KEY` | optional | Free Flash tier |
| `SAMBANOVA_API_KEY` | optional | Free tier |
| `OPENAI_API_KEY` | optional | PAID — last-resort spillover, tightly capped |

### Synthesis providers — pluggable registry, $0-safe (`src/providers.mjs`)

Providers are a **registry/factory**: add or reorder via `PROVIDER_ORDER`; each is
skipped if its key is absent. Default ladder:
**Cerebras → Gemini → SambaNova → OpenAI → Ollama**. (Groq and Cloudflare remain in
the registry but are OFF by default — no Groq key, and Cloudflare's billable
credentials are unwanted in a public repo; re-enable either via `PROVIDER_ORDER`.)

Cost model:
- **Free tiers** (Cerebras/Gemini/SambaNova) just rate-limit (429) when exhausted
  — no bill. They carry the load.
- **OpenAI is PAID** → placed LAST with a tight cap (`OPENAI_DAILY_CAP`), so it
  fires only if every free tier is exhausted → in practice ≈ $0. Model defaults to
  `gpt-4o-mini` (cheapest, highest limits; deliberately NOT a reasoning `o*-mini`).
- If everything is exhausted/unkeyed, the pipeline falls back to **extractive
  summaries** (no LLM, instant, hallucination-proof) — no story is ever dropped and
  no paid call is ever made beyond its cap.

Hosted inference is fast enough to LLM-synthesise the top ~400 events/run
(`SYNTH_HOSTED_MAX`); the score-sorted tail is handled extractively. Each run logs
`provider usage` so spend/limits are visible. Gemini uses a Flash **text** model
(set `GEMINI_MODEL` to your account's id — not a `*-live` realtime model).

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
