# Automatic spend guard, source milestone

Pi API reference: installed `@earendil-works/pi-coding-agent` 0.85.1.
Baseline pi-mantice revision: `f92888130a5941afdeb49118aff2d7a390236322`.
The npm latest release and installed package are 1.2.0 (npm modified
2026-09-10T00:15:43.061Z). This repair is unreleased and not globally installed.

## Confirmed prior behavior

`extensions/mantice-models.ts` already intercepts native compaction, including
threshold and overflow compaction. It prunes summary input on every invocation.
It emits a mechanical digest only when the mechanical gate was armed.
`src/fast-commands.ts` arms that gate through `/fast session` or `fast_session`;
the tool path waits for idle `agent_settled`, with no pending messages.
Pi itself checks its near-window threshold between tool turns. The missing
policy was extension-enforced early, absolute and token-throughput admission,
independent of an AI tool call and idle settlement.

## New enforcement

`src/spend-guard.ts` wraps both `stream` and `streamSimple` on both registered
provider APIs. It runs before the underlying transport. Exceptions become
terminal assistant errors through Pi's `lazyStream`, not ignored extension-hook
errors. There is no network request while the mechanical projection runs.

Soft thresholds, evaluated before each provider invocation:

- Context: the lesser of 50% of the advertised window and 200,000 tokens.
- Cumulative input, output, cache-read and cache-write: 8,000,000 tokens since
  the last request checkpoint.
- Same token sum over five minutes: 2,000,000 tokens since the checkpoint.
- Spend triggers require at least 32,000 context tokens.

Provider failures do not trigger request compaction. Mantice routing and its
structured circuit diagnosis own provider recovery; repeated failures with a
small request are not evidence that reducing conversation history will help.

Context uses the larger of serialized request bytes/4 (system prompt and tool
schemas included) and the latest provider-reported input/cache usage since the
checkpoint. This is a heuristic, not a tokenizer or USD billing calculation.
A tool result's `details` is excluded: providers transmit `content` only, while
`details` is local render state that Pi persists in the session file. Counting it
paused sessions over bytes nobody was ever billed for; one 537KB generated image
in `details` added about 179,000 tokens to every later request in its session.
No fixed wall-time or low turn-count cutoff is imposed on useful work.

The request projection retains about 20K recent tokens, moving the cut backward
to keep complete tool batches. Older content uses the existing <=64KB mechanical
digest. Original messages and session JSONL are preserved. A custom checkpoint
stores the original-prefix SHA256, boundary count, digest and digest SHA256.
Subsequent requests verify that binding before applying the projection.

This is **request-context compaction**, not a native `CompactionEntry` and not a
mutation of Pi's read-only SessionManager. Pi's raw message display and context
estimate can differ from the outgoing projection. Guard before/after estimates
are the admission evidence. Native auto-compaction continues to exist and now
always chooses mechanical output for threshold/overflow events. Deliberate
manual `/compact` remains an AI stage on bounded, pruned input.

## Emergency pause and coordination

Insufficient reduction (<10% estimated shrink or still above the context
threshold), missing reducible history, checkpoint integrity failure, interrupted
reduction and automatic mechanical-compaction failure persist a pause. The
wrapper refuses later requests, including queued continuations, without paid
transport. No overflow-shaped error or AI fallback is used for the brake.

A pause names the specific cause and carries the way out. An insufficient
reduction reports the measured before/after against the limit and then whichever
of three things actually blocked it: one retained message too large to fold away
(named by tool and clock time), the system prompt and tool schemas alone
exceeding the limit, or a diffuse tail with no dominant message. Each returns the
command that can clear it, and says so when `/mantice-guard retry` cannot: the
reduction never drops the newest tool batch, so a pause on a message inside it
needs `/tree` or `/new`. Summarizer pauses say that `/compact` stays blocked
while paused because summarizing is itself a paid request.

Custom entry: `mantice-spend-guard`.
Event bus: `mantice:spend-guard`.
Data: `{version:1,state:"ready"|"compacting"|"paused",reason,recovery?,outcome?,at,before?,after?,checkpoint?}`.
`recovery` is the human instruction recorded with the pause, so every later
request in the session repeats the same specific way out. `after` on a paused
record is the size the stalled reduction actually reached.
A valid managed-child tranche exhaustion adds `outcome:"budget_yield"`. The
subagent runtime preserves the session and partial output, releases capacity,
and wakes a still-active parent goal once. It does not block sibling admission.
Corrupt allowance records and guard-integrity failures remain pauses.
The event omits checkpoint content and adds `sessionId`. Records are branch-local
and restored on startup/tree navigation. A native compaction invalidates the
projection because it changes the original message prefix.

Goal/subagent owners must inspect the latest branch record and suppress
continuation while compacting or paused. Children must load this extension.
The wrapper still blocks paid calls if a non-cooperating goal queues work, but
this extension does not stop an external controller's CPU-only retry loop.

`/mantice-guard status` reports the state. `/mantice-guard retry` arms mechanical
rebuilding on the next request, without clearing the pause or starting work.
A ready admission follows only verified reduction. Repair the underlying cause
first; retry is not an override. Full history supplies the rebuild input.

## Direct verification

Temporary reproducible scripts and receipts:
`/tmp/mantice-incident-20260913/`.

- `guard-fixture.ts`: no-network fetch simulator, real installed Pi transport
  serialization, complete wire tool-pair checks, local tool outputs.
- `probe.mjs`: real RPC child, 36 consecutive tool calls and queued goal follow-up.
  38 intended calls total. Three reductions around 214K to 23K tokens, before
  idle. All 36 original tool results remain in session history. A giant latest
  request and subsequent continuation make zero calls after the brake.
- `threshold-probes.mjs`: real Pi JSON/print mode, persisted seeded sessions.
  Rate and cumulative triggers each reduce then permit one intended request.
  Restart of the RPC probe's paused session remains blocked with zero calls.
- The same real RPC 36-tool/queued-goal/brake probe also passed with
  `--no-session`: three reductions and zero calls after the brake. All original
  tool results remain in memory, but no session file or restart durability exists
  in that mode. Child launchers must remove `--no-session`, assign a stable
  per-worker session path, retain it with worker artifacts, and resume that exact
  session rather than replaying a fresh task. The extension cannot turn Pi's
  in-memory SessionManager into a persistent one.
- Packed tarball loaded through Pi's real extension loader passed the same
  36-tool/queued-goal/brake scenario. No external network or paid inference.
- Existing `npm test`, typecheck and `test:fast-wire` were run. No new test suite
  was added. Probe fixtures live outside the package.

## Adoption and remaining gaps

Version 1.3.0 bundles exact reviewed goal, subagent and sidebar component
tarballs. The package verifier extracts that artifact outside the checkout,
requires the expected bundled roots and entry points, loads every component
through real Pi RPC, then runs both wire checks. Registry publication,
installation and live-session reload remain separate evidence.

The provider-boundary guard covers the registered Mantice/Fornace transports,
not arbitrary direct HTTP tools, other providers, or children that omit the
extension. Existing admission retries established as unstarted remain inside
the transport wrapper. Goal accounting receives durable child input/output
receipts; cache channels remain observable but follow the goal package's
existing budget definition. The guard does not claim invoice-level USD
accounting or semantic task-progress classification. Thresholds remain initial
incident policy values pending production workload calibration.
