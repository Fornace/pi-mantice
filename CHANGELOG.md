# Changelog

## 1.4.4 (2026-09-14)

- Checkpoint prefix mismatch no longer pauses the session. A checkpoint is a
  caching optimization for projected request history; if message metadata or
  branch history differs between turns (e.g. Pi populates `usage`, reorders
  keys, or deserializes from disk), the cached checkpoint is simply invalid.
  The guard now silently discards the stale checkpoint and re-evaluates the
  full context, creating a fresh checkpoint only if context limits require it.
  Sessions paused under prior versions with `checkpoint prefix changed`
  automatically clear to `ready` on restore or request admission without
  requiring `/mantice-guard retry`.

## 1.4.3 (2026-09-14)

- A repair retry now re-evaluates the spend thresholds from scratch instead
  of demanding a verified reduction unconditionally. When the repaired
  request fits every threshold (for example after the 1.4.2 estimator fix
  removed a false positive), the retry admits it and clears the pause.
  Forcing a reduction anyway dead-ended the retry on the newest tool batch
  and re-paused a session with nothing left to repair. Threshold-triggered
  retries still compact as before.

## 1.4.2 (2026-09-14)

- Images no longer count at base64 wire size. A session that attached
  screenshots (4.3MB of base64 across three images) estimated over one
  million request tokens and hit the spend guard pause five times over the
  200K limit, stopping work on spend that never happens: providers bill the
  decoded raster, not the base64 encoding. The estimator now walks content
  blocks the way pi itself does, counting each image at a fixed 4800 chars
  (1200 tokens) and each thinking or tool-call block at text weight, with
  system prompt and tool schemas estimated separately.

## 1.4.1 (2026-09-14)

- Spend-pace triggers no longer pause the session when reduction cannot
  shrink the request. A long automation session crossed the 8M cumulative
  token threshold with a request already far below the context limit;
  mechanical reduction had nothing left to fold away, so the guard paused
  forever with an unrepairable cause and every retry re-paused identically.
  Work stopped with no way out. Cumulative and five-minute throughput
  thresholds now attempt the reduction as a token saving and, when it stalls
  or the request is one indivisible tool batch, admit the request unreduced
  with a visible warning: the request fits, so it runs. Only a request that
  genuinely cannot fit the context limit still pauses, with its named
  blocker. Pace admissions cool down for one rate window so a session over
  the lifetime threshold does not re-attempt or re-notify on every request.

## 1.4.0 (2026-09-14)

- A tool result's `details` no longer counts against the request estimate.
  Providers transmit `content` only; `details` is local render state that Pi
  persists in the session file. A 537KB image left there by an image tool added
  716,624 base64 characters — about 179,000 tokens — to every later request in
  that session, and paused a live session at 232,770 estimated tokens while the
  provider was billing 48,999. Replaying that session's messages: 347,604 tokens
  before this change, 131,083 after.
- `mechanical reduction made insufficient progress` is gone. A stalled reduction
  now reports what it measured (before, after, limit) and which of three things
  blocked it: one retained message too large to fold away, named by tool and
  clock time; the system prompt and tool schemas alone over the limit; or a
  diffuse tail with no dominant message.
- Every pause carries its own recovery instruction and persists it, so the
  repeat error on each later request says the same specific thing. Pauses that
  `/mantice-guard retry` cannot clear now say so and name `/tree` or `/new`
  instead — reduction never drops the newest tool batch, so retrying a pause on
  a message inside it stalls identically.
- `no reducible history before retained tail` now reads `the request is already
  one indivisible tool batch`, with the matching recovery.
- A paused record stores the size the stalled reduction actually reached instead
  of carrying forward the previous `after`.

## 1.3.0 (2026-09-13)

- Keep provider failures in Mantice routing instead of treating six errors as
  evidence for request compaction.
- Emit `budget_yield` when a managed child reaches its durable token tranche so
  the parent can continue from partial work without blocking sibling admission.

## 1.2.1 (2026-09-13)

- Encode `fast_read.level` as a string enum. Gemini subscription requests no
  longer receive unsupported `const` fields from this tool.
- No routing, pricing or automatic-guard policy changes in this hotfix.

## 1.2.0 (2026-09-10)

- New `fast_session` tool: the agent-callable twin of `/fast session`. It
  arms the mechanical gate mid-turn and fires the exact same compaction
  path on the first idle `agent_settled`, so it never aborts an active
  run. While armed, threshold and overflow auto-compactions also turn
  mechanical (zero model calls). Agents should call it at ~50% context
  usage and then finish their reply.
- `MechanicalGate` gained a `has()` probe so the tool trigger can tell an
  armed gate from one already consumed by an auto-compaction.

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
