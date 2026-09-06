# pi-mantice

Mantice gateway integration for [Pi](https://github.com/badlogic/pi-mono):
live model catalog with capability fields, class-aware metadata, flash-class
compaction, canonical overflow recovery, and first-install setup.

Absorbs and replaces `fornace-pi-models`.

## What it does

- Registers `mantice` (groups + aliases) and `fornace` (curated groups) from
  the authenticated `GET /v1/models` at startup. One fetch shared by both.
- Derives Pi model metadata from the gateway's capability fields (`mode`,
  `class`, `input_modalities`, `thinking`) instead of hardcoded id lists.
  Gateways without those fields fall back to the legacy literal classifier
  with one loud warning; gateways with them fail closed on missing rows.
- Fail-closed guard: `fornace-max`/`max` must advertise > 128K context or
  registration aborts with the offending row named. A stale or missing
  client-side window silently strangles compaction (see the 2026-09-03
  incident notes in `docs/PLAN.md`).
- Compaction summarizes with the flash class route (`fornace-flash`),
  falls back to `fornace-fast`, and never automatically spends the session's
  max-class model on summarization. Usage is recorded into session totals.
  Transient summary failures use Pi's bounded retry helper and persisted retry
  settings before class fallback. Cancellation interrupts backoff; recognized
  policy rejections preserve the transcript without retry or class fallback.
  On stable Pi >= 0.85.1 with retries enabled, automatic compaction keeps waiting
  through transient class-route outages, retrying eligible routes every 30–60s
  until recovery or cancellation. Permanent failures are not repeatedly called.
  Older runtimes retain bounded recovery because their RPC abort does not cancel
  compaction reliably. Manual compaction can use Pi's default fallback only when
  no pruning or chunking occurred.
- Before compaction, preserve all user messages and the last two user-led rounds.
  Aggressively prune older non-user history: strip reasoning and tool payloads,
  retain compact tool-call references and paths, bound older assistant text, and
  collapse exact repeated replies. Original session history remains recoverable.
  Recent tool text bypasses Pi's default serializer truncation. Oversized input
  is chunked; completed parts are checkpointed for interrupted compactions.
- Native [RTK](https://github.com/rtk-ai/rtk) integration rewrites supported Bash
  commands for Mantice sessions to return compact output. Install the `rtk`
  binary on PATH (`brew install rtk` on macOS); no separate Pi RTK extension is
  needed. An existing RTK extension can coexist. `RTK_DISABLED=1` opts out;
  missing RTK preserves normal command execution and history pruning.
- Overflow recovery: upstream context-miss wordings (including Z.ai code
  1261) are canonicalized to `context_length_exceeded` so Pi auto-compacts
  and retries once. Rate limits and route-availability errors are never
  rewritten.
- Failover transparency: one notice per backend model change on a route
  (`fornace-max served by glm-5.3`), context math untouched.
- Session isolation: agent requests to Mantice providers send one opaque
  `X-Mantice-Session-ID`, stable across resume and different for new sessions.
  This enables gateway-side session-local recovery without modifying payloads
  or cache-affinity headers. Requires Pi's `before_provider_headers` hook
  (verified with Pi 0.84.4). Other providers are untouched.

## Install

```sh
pi install npm:pi-mantice        # from the npm registry
pi install git:github.com/Fornace/pi-mantice@v1.0.0   # straight from the repo
```

Requires `MANTICE_API_KEY` (and optionally `MANTICE_BASE_URL`) in the
environment. Remove any hand-written `mantice`/`fornace` blocks from
`~/.pi/agent/models.json`; this package owns both providers.

## Setup for your own gateway

`/mantice-setup` walks a fresh Mantice installation: probes your provider
credentials, discovers models, classifies them into `max`/`reasoning`/
`fast`/`flash` plus modality groups using the daily
[pi-frontier](https://www.npmjs.com/package/pi-frontier) snapshot, shows the
full routing plan, and publishes it only after you type `APPLY` against the
current `routing_revision`. Non-empty registries require `--replace`.
Fornace production hosts are blocked by default.

## Verify

```sh
npm test          # unit tests, no Pi or network needed
npm run typecheck
npm run test:session-wire # real Pi CLI against an isolated loopback fixture
MANTICE_BIN=/absolute/path/to/mantice npm run test:session-recovery # full local chain
npm run snapshot  # refresh extensions/models-snapshot.json from the live catalog
npm run audit     # spawn a real Pi and compare its registry to the live catalog
```

## Layout

- `src/catalog.ts` live/snapshot catalog → Pi model entries (both tiers)
- `src/classes.ts` class policy: max/reasoning/fast/flash, compaction chain
- `src/summarize.ts` `session_before_compact` flash-chain summarization
- `src/overflow.ts` canonical overflow mapping + response-model notices
- `src/frontier.ts` pi-frontier join used by setup and annotations
- `extensions/mantice-models.ts` Pi wiring (the only extension file)
- `docs/PLAN.md` architecture plan, incidents, and rollout gates

## Publishing

First publish is manual (`npm login` + `npm publish`); from there the tag
push `v*` workflow runs OIDC trusted publishing with provenance.
