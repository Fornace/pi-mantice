## 1.1.1 (2026-09-08)

- Resolve Chat Completions and Responses through Pi's bundled API factories.
  Installed packages now load and stream with host-provided Pi dependencies.
- Pass the host-resolved Chat Completions transport into admission recovery,
  preserving its retry and cancellation behavior.
- Run existing wire verification from the packed artifact in CI and publishing.
  Correct the fixtures' required `max` catalog alias and surface catalog warnings.

## 1.1.0 (2026-09-08)

- Two-stage compaction: `/fast session` now performs stage 1 mechanically
  (deterministic bounded digest, zero model calls, millisecond scale) and
  `/compact` remains Pi native, receiving the pruned payload. The flash-chain
  summarizer, chunking and part checkpoints were removed with it.
- New `fast_read` and `fast_write` RTK tools for cheap filtered file reads
  and write receipts.
- Fixed a dead customInstructions injection: Pi 0.85.1 never read back
  `session_before_compact` mutations, so pruning markers now live in the
  pruned messages themselves.

## 1.0.1 (2026-09-03)

- CI: declared `@types/node` as a dev dependency so `npm ci` typechecks on a
  clean install; the v1.0.0 tag workflow failed at typecheck before reaching
  publish. No runtime changes.
# Changelog

## 1.0.0

- Live capability-aware catalog (absorbs fornace-pi-models a2a63f7).
- Flash-chain compaction with usage accounting and cancel-before-max policy.
- Canonical overflow mapping including Z.ai 1261; route/backend change notices.
- /mantice-setup onboarding planner (see docs/PLAN.md M4).
