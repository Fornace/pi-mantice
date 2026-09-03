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
  falls back to `fornace-fast`, and cancels rather than spending the session's
  max-class model on summarization. Usage is recorded into session totals.
- Overflow recovery: upstream context-miss wordings (including Z.ai code
  1261) are canonicalized to `context_length_exceeded` so Pi auto-compacts
  and retries once. Rate limits and route-availability errors are never
  rewritten.
- Failover transparency: one notice per backend model change on a route
  (`fornace-max served by glm-5.3`), context math untouched.

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
