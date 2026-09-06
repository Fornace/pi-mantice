# Sustained automatic compaction recovery

Reviewed 2026-09-06 02:07 UTC. Local implementation, not released yet.

Evidence: installed development SDK0.85.1 `_runAutoCompaction` treats an
extension cancel result as aborted with willRetry=false. Therefore exhaustion
of bounded flash/fast retries previously ended recovery and required a user.
Current official extension and retry source GETs returned200 at04:06:50/51 local:

- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/utils/retry.ts

The plugin now distinguishes SDK-classified transient assistant errors from
permanent failures. After bounded per-route retries, automatic compaction waits
30–60 seconds (jitter), then retries only transiently failed class routes.
The same pending compaction remains owned by Pi, preserving its transcript,
instructions, and continuation state. No partial summary is committed.
Recognized policy errors remain terminal before this classification. Abort is
terminal. Manual compaction retains its existing bounded/default fallback path.
Disabled retry settings disable this sustained recovery too.

Important runtime boundary: global Pi still reports0.84.4. Its RPC abort does
not propagate to compaction (earlier real reproducer recorded in cancellation
receipt);0.85.1 fixes this. Sustained recovery is gated on exported SDK VERSION
being a stable version >=0.85.1. Unknown/prerelease versions do not enable it.
Existing older sessions require a safe runtime upgrade before this behavior
can be claimed for them. No hot reload/restart/upgrade was performed here.

Local verification: typecheck and all32 existing tests pass. Ephemeral direct
probes show flash401 excluded after first round, fast503 recovering next round,
policy rejection stopping without waiting/rerouting, immediate wait abort, and
runtime version boundary. No new permanent test files or provider calls.
Real Pi automatic-compaction continuation and RPC abort of the new cooldown
remain required before publication. Sustained wait does not survive process
death by itself; crash/session restart recovery is a separate requirement.

## Real runtime verification

Disposable fixture `/tmp/pi-compaction-outage.xzkxqa/probe.mjs` launched the
repo-local Pi0.85.1 RPC process with the actual modified extension, isolated
settings/session storage and synthetic loopback HTTP. No real provider calls.
The first prompt seeded history; the next received a short length-stopped
response. Pi entered automatic overflow compaction. The summary route returned
503 until the real30–60s recovery cooldown began. The fixture did not replace
the timer or call the compaction helper directly.

Recovery PASS: after the timer, Pi received a complete summary, emitted
compaction_end with willRetry=true, and automatically completed the interrupted
turn (three normal inference attempts total: seed, truncated, recovered).
Cancellation PASS in a fresh process: RPC abort during cooldown settled within
5s, emitted aborted compaction with willRetry=false, saved zero compaction
entries, made no extra summary call, and completed a subsequent prompt in the
same session. Both disposable processes exited and loopback server closed.

Typecheck and real ModelRegistry compaction-wire verification also passed.
These results supersede the pending real-lifecycle checks above, not the pending
fleet runtime upgrade or publication. Global Pi remains0.84.4 at this check.
