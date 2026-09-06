# Prune-first compaction and durable part progress

Implemented locally on 2026-09-06. Not yet selected in running sessions or
published to npm. This supersedes the no-checkpoint limitation in the earlier
bounded-compaction receipt, once this code is selected.

Before serialization and splitting, replace successful historical tool results
larger than 2,048 UTF-8 bytes with a static recovery marker and tool name/call ID.
Preserve small results, errors, unknown outcomes, user messages, assistant
messages and tool-call arguments. Remove duplicate result details only from
the summarizer copy. Original session entries and recent kept context are not
modified. The marker directs recovery from history/artifacts first, safe
read-only checks only, and RKT if available; it never authorizes replaying
mutations or paid jobs. No semantic classifier or extra model call is used.

If pruned compaction fails, do not fall back to Pi's raw-input compactor.
Provider policy cancellation remains terminal. Output summaries remain lossy;
important facts present only in stripped output must be recovered from history.

Completed chunk summaries are saved as custom session entries, outside model
context. Reuse requires the same original input fingerprint, pruning version,
instructions, session, candidate models, kept boundary and chunk count.
Only active-branch progress after the latest committed compaction is eligible,
and only for 24 hours. Malformed state is ignored. One final compaction is
returned after all parts succeed; abort/failure never commits a partial summary.
This provides process-restart recovery, not a filesystem power-loss guarantee.

## Evidence

- Typecheck and all 32 existing tests passed; no retained tests added.
- Disposable pruning fixture: immutable original, preserved user/small/error/
  unknown results, removed details, recoverable call ID, 300 KB result reduced
  to one bounded request, no raw-input fallback after failure.
- Actual SessionManager fixture: own child SIGKILL after first saved part;
  fresh process/session load completed only two remaining parts, aggregated
  usage across all three, and appended exactly one final compaction.
- Isolated Pi 0.85.1 RPC overflow fixture: four bounded summaries, maximum
  serialized request messages 256818 bytes, one saved compaction, automatic
  continuation. Synthetic loopback only; no provider jobs or sibling work.
- Read-only Torchio historical sample: messages since preceding compaction
  before the recovered 04:38:33 UTC compaction, not the exact prepared boundary.
  301 stripped results; serialized bytes 3,198,362 -> 2,675,269 (16.36% reduction),
  approximate 256 KB parts 13 -> 11 excluding previous summary/instructions.
  Pi already truncates tool results; this sample has substantial tool-call
  arguments. This is not evidence for a universal 90% reduction or token savings.

## Sources

Official extensions documentation reviewed 2026-09-06 09:49:56 UTC via
Scrapling HTTP, raw response HTTP 200:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md

Installed Pi coding-agent/pi-ai 0.85.1 source/types inspected for
appendEntry, SessionManager persistence/getBranch, ToolResultMessage,
prepareCompaction, convertToLlm and serializeConversation. Custom entries do
not enter model context. Serializer already truncates individual tool output.
Existing live Torchio process is 0.84.4 and was not reloaded for this change.
