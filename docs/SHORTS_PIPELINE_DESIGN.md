# Agyata Shorts — Automated Video Pipeline (Design)

> Turn the news we already synthesize into **watchable, monetizable YouTube Shorts**,
> ~98% automated with a fast human-approval gate. Two independent channels, one shared
> render engine. This doc is the plan; code lands under `scripts/shorts/`.

---

## 0. Why two pipelines (the money reason)

Research finding that shapes everything: **YouTube pays by VIEWER geography, not creator
geography.** US/UK viewers earn **5–15× India's CPM** (US ~$12 CPM vs India ~$1). A
single India-audience channel is capped at India rates no matter how good it is. So:

| Channel | Language | Audience target | Why |
|---|---|---|---|
| **Agyata World** | **English** | US / UK / global | Tier-1 CPM — the *earnings* engine |
| **Agyata भारत** | **Hindi / Hinglish** | India | Volume + reach — the *growth* engine, funnels to the app |

Same render engine, two configs. English channel is where the money is; Hindi channel is
where the audience + app installs are. Both $0 to run.

---

## 1. The honest monetization reality (so expectations are right)

From sourced 2026 research (full citations in the strategy section at bottom):

- **YPP bar:** 1,000 subs + (4,000 watch-hrs **or** 10M Shorts views/90d). ~1 month review.
- **Shorts pay little directly:** ~$0.05–0.20 RPM (US), far less in India. Shorts are for
  **reach/subscribers**, not ad income. The real money is long-form ads (tier-1) +
  funneling viewers to **agyata.com** (your own ads/plans) + eventually sponsorships.
- **The 2025 "inauthentic content" policy is the real risk:** templated, mass-produced,
  zero-commentary AI videos get **demonetized**. AI tooling is explicitly *allowed* when
  each video adds original value. → This is exactly why we keep a **human-approval gate**
  and vary each video. Automation does the labor; a human keeps it authentic.
- **AI disclosure:** a generic TTS narrator reading factual news is **not** the disclosure
  trigger (that's for impersonating real people). We'll still tick YouTube's "altered
  content" box when using AI voice — disclosure is free and doesn't hurt reach.

**Blunt math:** 100k views/mo ≈ pocket money. Meaningful income needs 1M+ views/mo,
and tier-1 (English) at that scale is ~5–10× the India figure. This is a compounding
game measured in months, not a switch that prints money.

---

## 2. Architecture — how it runs (mirrors your CURRENT news pipeline)

You already run: **Cloudflare Worker cron-pinger → `workflow_dispatch` → GitHub Actions**
(GitHub's own `schedule:` was removed for dropping ticks). The Shorts pipeline plugs into
the **exact same mechanism** — two new workflow files, two new lines in the pinger.

```
                    ┌─────────────────────────────────────────────┐
   Cloudflare       │  agyata-cron-pinger  (Worker, already live)  │
   cron (1/min) ───▶│  WORKFLOWS += shorts-en.yml, shorts-hi.yml   │
                    └───────────────┬─────────────────────────────┘
                                    │ workflow_dispatch (reliable clock)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  GitHub Actions runner (public repo = free)  │
                    │  ┌────────────────────────────────────────┐ │
                    │  │ 1. FETCH   newest stories from agyata API│ │
                    │  │ 2. SCRIPT  pick 1 hot story → shorts copy│ │
                    │  │ 3. TTS     Kokoro → narration + timings   │ │
                    │  │ 4. VISUALS Pexels stock / story image     │ │
                    │  │ 5. FRAMES  SVG → PNG (headline+captions)  │ │
                    │  │ 6. RENDER  ffmpeg → 1080×1920 H.264 MP4    │ │
                    │  │ 7. STAGE   commit MP4+meta to a review dir│ │
                    │  └────────────────────────────────────────┘ │
                    └───────────────┬─────────────────────────────┘
                                    │ (artifact: rendered Short + metadata)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  HUMAN APPROVE GATE  (the ~2%)               │
                    │  You glance (~30s) → approve / kill          │
                    │  approve = a second workflow uploads it      │
                    └───────────────┬─────────────────────────────┘
                                    │ videos.insert (OAuth, 100/day free)
                                    ▼
                              YouTube (EN channel / HI channel)
```

**Why this shape:**
- **Reuses your proven infra** — same pinger, same Actions-on-public-repo (free minutes),
  same "commit artifacts to the repo" pattern your news pipeline already uses.
- **Render on the Actions runner** (Ubuntu): ffmpeg + Kokoro + rsvg all install there;
  a 30–50s Short renders in well under a minute on a 2-vCPU runner.
- **Human gate = a separate `shorts-upload.yml`** you trigger (or a tiny approve UI later).
  Nothing auto-posts. This is the monetization-safety valve.
- **`$0`:** public repo = unlimited Actions minutes; Kokoro/ffmpeg/rsvg/Pexels all free;
  YouTube upload API free (100 uploads/day, 1 unit each — 2025 quota model).

### Cadence (tunable in the pinger, exactly like buzz/pipeline today)
- `shorts-en.yml` — e.g. every 2h, picks the top *global-interest* English story.
- `shorts-hi.yml` — e.g. every 2h offset, picks the top India story, Hindi/Hinglish.
- Start conservative (2–4 Shorts/day/channel). Volume ≠ growth; consistency + quality do.

---

## 3. The render engine (the part that doesn't exist yet)

All verified working in this environment before committing to the design:

| Stage | Tool | License | Verified |
|---|---|---|---|
| TTS (EN) | **Kokoro** `af_heart` | Apache-2.0 ✅ commercial | 7.2s clean clip ✅ |
| TTS (HI/Hinglish) | **Kokoro** `hf_alpha` | Apache-2.0 | Hindi+English mix clip ✅ |
| Captions | Kokoro/`misaki` timings → SVG | — | word/phrase timing ✅ |
| Visuals | story image + **Pexels** stock API | free, commercial | (API key needed) |
| Frames | **rsvg-convert** SVG→PNG (Devanagari-safe) | — | already used for social cards ✅ |
| Composite | **ffmpeg** `zoompan`(Ken Burns)+`overlay`+`amix` | LGPL/GPL | filters present ✅ |
| Encode | ffmpeg `libx264` + `videotoolbox` | — | present ✅ |

> Note: this ffmpeg build has **no `drawtext`/libass**, so ALL text is rendered as
> **SVG→PNG overlays** (full brand-font + Devanagari control) and composited — more robust
> than in-ffmpeg text anyway, and reuses your existing card renderer.

**Anatomy of one Short (30–50s, 1080×1920):**
1. **Hook (0–2s):** brand sting + the headline as a punchy on-screen line, TTS hook.
2. **Body (2–45s):** the story image with slow Ken-Burns zoom, **captions animating in
   sync** with the narration (word/phrase pop), category + `#hashtag` chip, source credit.
3. **Outro (last 3s):** "Full story → agyata.com" + Subscribe CTA + channel mark.
4. **Audio:** Kokoro narration mixed over a soft royalty-free music bed (ducked), loudness
   normalized to ~-14 LUFS (YouTube target), fade in/out.
5. **Quality gates before it's accepted:** audio duration == video duration (±0.1s, no
   A/V drift), loudness in range (not silent/clipping), file plays clean (ffprobe validates
   streams). A render that fails any gate is rejected, never staged — your "no buggy
   video" requirement enforced in code.

---

## 4. Repo layout (what I'll build)

```
scripts/shorts/
  config.mjs        # per-channel config (EN/HI): voice, lang, dims, brand, cadence
  tts.mjs           # Kokoro narration + word/phrase timings  [Kokoro chosen]
  visuals.mjs       # resolve story image; Pexels fallback; download+cache
  frames.mjs        # build per-beat SVG (headline/caption/brand) → PNG via rsvg
  render.mjs        # ffmpeg: frames + Ken-Burns + captions + audio + music → MP4
  build_short.mjs   # orchestrator: story → validated MP4 + upload metadata JSON
  upload.mjs        # YouTube Data API v3 videos.insert (OAuth, resumable)
  assets/music/     # royalty-free beds (CC0)
docs/youtube/shorts/<channel>/<stamp>/   # staged output: short.mp4 + meta.json (review)
.github/workflows/
  shorts-en.yml     # render EN Short  (dispatched by pinger)
  shorts-hi.yml     # render HI Short
  shorts-upload.yml # human-approved upload (manual dispatch w/ the stamp to publish)
```

Cron-pinger gets 2 new lines (`shorts-en.yml`, `shorts-hi.yml`) — nothing else changes.

---

## 5. Secrets / setup you'll provide (one-time)

- **PEXELS_API_KEY** — free (pexels.com/api). Stock B-roll fallback.
- **YouTube OAuth** — a Google Cloud project + OAuth client; a refresh token per channel
  (`YT_REFRESH_TOKEN_EN`, `YT_REFRESH_TOKEN_HI`) stored as repo secrets. Upload API is free.
- (Kokoro voices, ffmpeg, rsvg install on the runner from pip/apt — no secret.)

Until secrets exist, the pipeline still **renders + stages** videos (you download/upload by
hand); upload automation switches on once the tokens are set. Nothing blocks on setup.

---

## 6. Build order (this session)

1. `config.mjs` + `tts.mjs` (Kokoro EN + HI) — the foundation.
2. `visuals.mjs` + `frames.mjs` — image + caption frames.
3. `render.mjs` + `build_short.mjs` — composite + validate.
4. **Render one real EN Short and one real HI Short from live stories; validate A/V.** ← proof
5. `upload.mjs` + the 3 workflows + pinger lines.
6. PR with everything + this doc.

---

## 7. Monetization strategy (beyond ad RPM)

Shorts alone won't pay much. The stack that actually earns:
1. **English channel → tier-1 ad revenue** once monetized (the 5–15× multiplier).
2. **Every video funnels to agyata.com** (description + outro) → your *own* site ads +
   future partner plans monetize that traffic at rates you control.
3. **Hindi channel → reach + app installs + breaking-news push subscribers** (compounds the
   whole product, not just YouTube).
4. **Later:** sponsorships/brand deals (where Indian news creators actually earn), community
   memberships, and X cross-posting (low direct pay, but free reach).

The pipeline makes (1)–(3) nearly free to run at volume. Human judgment (the approve gate)
is what keeps it monetizable under the 2025 authenticity rules.
```
