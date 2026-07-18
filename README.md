# content-sync-worker

Scheduled content aggregation + summarization pipeline. Fetches public RSS
sources, groups related items, ranks by cross-source frequency, summarizes with
a local model on the runner, and posts results to a configured HTTPS endpoint.

Runs entirely on the CI runner — no external servers.

Sources: curated public RSS feeds, plus an optional global-firehose source for
extra cross-source coverage (see below).

## Configuration (repository secrets)

| Secret | Purpose |
|---|---|
| `INGEST_URL` | HTTPS endpoint that accepts summarized items |
| `STORIES_URL` | HTTPS endpoint for the dedup/update reference list |
| `NEWS_INGEST_TOKEN` | Bearer token for the ingest endpoint |

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
