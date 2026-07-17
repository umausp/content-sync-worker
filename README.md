# content-sync-worker

Scheduled content aggregation + summarization pipeline. Fetches public RSS
sources, groups related items, ranks by cross-source frequency, summarizes with
a local model on the runner, and posts results to a configured HTTPS endpoint.

Runs entirely on the CI runner — no external servers.

## Configuration (repository secrets)

| Secret | Purpose |
|---|---|
| `INGEST_URL` | HTTPS endpoint that accepts summarized items |
| `NEWS_INGEST_TOKEN` | Bearer token for that endpoint |

## Run

Automatically on a schedule (see `.github/workflows/pipeline.yml`) or manually
via the workflow's "Run workflow" button.

Tunables live in the workflow env: `OLLAMA_MODEL`, `MAX_STORIES`,
`MIN_IMPORTANCE`, `PER_FEED`.
