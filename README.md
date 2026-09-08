# pi-mantice

Mantice gateway integration for [Pi](https://github.com/badlogic/pi-mono):
live model catalog with capability fields, class-aware metadata, two-stage
fast compaction (mechanical pruning plus Pi native AI summaries), RTK fast
file tools, canonical overflow recovery, and first-install setup.

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
- Two-stage compaction. Stage 1 (`/fast session`) is aggressive mechanical
  pruning: the summarized span is replaced by a deterministic, byte-bounded
  digest (default ceiling 64 KiB) in milliseconds, with zero model calls. All
  user messages are retained as chronological excerpts (progressive caps
  16 KiB to 128 B under budget pressure); older reasoning and tool payloads
  become references; assistant text becomes deduplicated excerpts. Stage 2
  stays Pi native: `/compact` (manual or auto) summarizes the pruned payload
  with the session model, so the AI summary never sees unpruned bulk.
  Original session history always remains recoverable in the JSONL.
- Native [RTK](https://github.com/rtk-ai/rtk) integration: supported Bash
  commands are rewritten for Mantice sessions to return compact output, and
  the `fast_read` / `fast_write` tools expose RTK's filtered read and
  heuristic smart summary as first-class tools for cheap file re-reads after
  compaction. Install the `rtk` binary on PATH (`brew install rtk` on macOS);
  no separate Pi RTK extension is needed. An existing RTK extension can
  coexist. `RTK_DISABLED=1` opts out of command rewriting; missing RTK
  preserves normal command execution and history pruning.
- Overflow recovery: upstream context-miss wordings (including Z.ai code
  1261) are canonicalized to `context_length_exceeded` so Pi auto-compacts
  and retries once. Rate limits and route-availability errors are never
  rewritten.
- Failover transparency: one notice per backend model change on a route
  (`fornace-max served by glm-5.3`), context math untouched.
- On Pi >= 0.85.1 with retries enabled, explicit gateway admission failures
  keep the original request alive and retry every 30–60 seconds until capacity
  returns or you cancel, including pre-execution deployment drain/quiesce and
  full worker pools. Requires the gateway's `X-Mantice-Admission` marker,
  recognized admission code, and `upstream_started: false` on every HTTP attempt.
  No new user message or history rewrite occurs. Policy rejections, ambiguous
  transport failures, partial output and unmarked upstream errors keep their
  normal handling. This is not restart recovery or a universal error retry loop.
- Session isolation: agent requests to Mantice providers send one opaque
  `X-Mantice-Session-ID`, stable across resume and different for new sessions.
  This enables gateway-side session-local recovery without modifying payloads
  or cache-affinity headers. Requires Pi's `before_provider_headers` hook
  (verified with Pi 0.84.4). Other providers are untouched.

## Install

```sh
pi install npm:pi-mantice        # from the npm registry
pi install git:github.com/Fornace/pi-mantice@v1.1.1   # straight from the repo
```

Requires `MANTICE_API_KEY` (and optionally `MANTICE_BASE_URL`) in the
environment. Remove any hand-written `mantice`/`fornace` blocks from
`~/.pi/agent/models.json`; this package owns both providers.

## Fast commands

`/fast` shows help; subcommands have completion.

| Command | Action |
| --- | --- |
| `/fast session [focus]` | Mechanical compaction now: replace the summarized span with a bounded digest, zero model calls, optionally carrying a focus line, e.g. `/fast session deployment` |
| `/fast preview` | Estimate pruning savings without a model call |
| `/fast status` | Show context usage, selected model, stage status and last compaction |
| `/fast rtk` | Check the installed RTK binary and restore native integration after installation |
| `/compact` | Stage two: Pi native AI-assisted compaction of the pruned context |

Mechanical compaction preserves the original history in the session JSONL and
makes no LLM request; the digest is bounded (64 KiB ceiling), deterministic and
carries every user message as an excerpt. It requires an idle session without
queued messages and does not resume its task. Empty or already compact sessions
return a simple notice. `/compact` runs Pi's own summarizer on the pruned
payload. Preview measures serialized active-context bytes; the actual
summarization span also depends on Pi's retained window. Status, preview, help
and RTK checks do not call a model. `RTK_DISABLED=1` remains respected by the
RTK check.

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
npm run verify:package    # both wire checks from the tarball without local Pi peers
MANTICE_BIN=/absolute/path/to/mantice npm run test:session-recovery # full local chain
npm run snapshot  # refresh extensions/models-snapshot.json from the live catalog
npm run audit     # spawn a real Pi and compare its registry to the live catalog
```

## Layout

- `src/catalog.ts` live/snapshot catalog → Pi model entries (both tiers)
- `src/classes.ts` class policy: max/reasoning/fast/flash
- `src/summary-pruning.ts` mechanical pruning of the summarizer's copy
- `src/mechanical-compaction.ts` bounded digest builder (stage 1)
- `src/fast-commands.ts` `/fast` commands and the mechanical gate
- `src/rtk.ts`, `src/rtk-tools.ts` RTK command rewriting and fast tools
- `src/overflow.ts` canonical overflow mapping + response-model notices
- `src/frontier.ts` pi-frontier join used by setup and annotations
- `extensions/mantice-models.ts` Pi wiring (the only extension file)
- `docs/PLAN.md` architecture plan, incidents, and rollout gates

## Publishing

The tag-push `v*` workflow uses npm trusted publishing with provenance. It
requires effective npm authorization for `Fornace/pi-mantice`, `publish.yml`,
and direct publishing. An npm E404 alone does not identify which permission
or identity setting is wrong; inspect the authenticated package settings.
Do not replace an existing staged-approval policy without owner authorization.

For a new release, review and validate current main, choose an unused package
version and matching fresh tag, and push through this workflow. It checks that
the tag matches `package.json` and that the checked-out event commit is current
main, both before validation and immediately before publishing. A main update
detected at either check stops publication. Never move an existing tag to work
around this. Tracked source changes also stop publication. These checks are
not an atomic lock on future main updates.
Older workflow runs retain their old workflow and do not gain this guard:
rerunning the old `v1.0.1` run cannot distribute newer recovery fixes.

Source push, npm publication, installation and loaded-session adoption are
separate states. Verify registry version and gitHead after a successful publish.
