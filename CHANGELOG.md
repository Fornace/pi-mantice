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
