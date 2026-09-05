# Session identity integration

Status: source implementation, not installed in existing sessions or released.

The deployed Mantice recovery preference requires explicit authenticated
X-Mantice-Session-ID. Content-first cache affinity is intentionally different
and must not be reused as a session isolation boundary.

registerSessionIdentity uses Pi before_provider_headers for mantice/fornace.
Identity is pi- plus SHA256(version domain + current persisted Pi session ID).
No random per-request IDs, payload rewriting, model changes, request retries,
cache setting changes, or safety refusal bypass. Case variants collapse to one
header. Missing identity sends none rather than inventing a shared fallback.
New session IDs differ; reopening the same persisted session keeps identity.

Verification2026-09-05:
- npm run typecheck and all29 unit tests pass.
- Real installed Pi0.84.4 CLI ran three loopback-only synthetic turns, same
  persisted UUID twice and a different UUID once. Exactly one canonical header
  per request, stable first pair, distinct third, prompt/auth preserved.
- Raw verifier result: session-wire: PASS; real Pi CLI sends one stable header
  across resume, isolates new sessions, preserves prompt and authorization.
- tools/verify-session-wire.mjs isolates config/session directories and disables
  tools/extensions discovery/context files/startup network/telemetry. It loads
  only the source extension, uses fake credentials and deletes its own temp data.
- CI and publish gates include this wire test. No live conversation replay.

Official evidence reviewed2026-09-05:
- https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md
  HTTP200 at17:03UTC. before_provider_headers mutates assembled headers;
  provider retries reuse them. Current installed sdk.js and runner.js confirm
  agent streamFn invokes this handler; ctx exposes sessionManager.getSessionId.
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
  HTTP200 at17:07UTC. Used to compare verification approaches; final verifier
  uses installed CLI --print/--session-id rather than RPC.
- Installed pi --help verifies explicit extension, isolated config, offline,
  session-id, print and no-context flags. Node26 locally; CI Node24.
- Past30-day search6820eda05e22975912105c75836561b1 returned undated docs only,
  not evidence of a recent change. Raw /tmp/mantice-pi-headers-freshness-20260905.json.

Still required: CI proof, release/install through supported workflow, controlled
reload of actual users, and real Pi -> Mantice -> mock-provider chain recovery
test (the current wire test proves headers, gateway fixtures prove routing
separately). Compaction subrequests are not covered by this agent header hook.
Latest observed Publish runs33768229739 cancelled/33759548513 failed; do not
assume npm trusted publishing is configured or claim package release succeeded.

Follow-up verification17:20UTC:
- f7a8c7b CI33980223281 succeeded (unit/typecheck/real Pi wire verifier).
- New verify-session-recovery.py uses real Pi RPC, real Mantice release binary,
  disposable SQLite/auth and local mock providers. Four turns pass: initial
  modality failure then fallback, resumed-session fallback first, different
  session original order, different credential original order. The complete
  triggering text and PNG bytes match across attempts; exactly three scoped
  preferences persist. No real provider traffic or installed plugin changes.
- Negative control with installedv1.0.0 fails on the second turn: it retries
  reject-image then accept-image instead of reusing the learned destination.
- Raw positive result: session-recovery-chain: PASS; real Pi + Mantice, full
  text/image failover, resumed preference, other-session and credential isolation.
- Fresh SQLite transaction and Pi RPC docs HTTP20017:17UTC, installed source
  and CLI contract inspected. The combined gate belongs in Mantice CI because
  Mantice is private; pi-mantice CI must not assume cross-repository credentials.
