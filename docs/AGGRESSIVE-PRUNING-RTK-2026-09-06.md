# Aggressive pruning and native RTK

User directive: preserve full user messages, aggressively prune everything
older than the last two rounds. A round starts at a user message and includes
its responses and tool activity. This supersedes the earlier 2 KiB successful
result-only rule. Original JSONL remains unchanged; this changes the input to
the summarizer, whose output is still a summary.

The active session branch supplies the last-two-round boundary even when Pi
keeps recent messages outside the summarized span. Older reasoning is removed;
all older tool results become ID/error-status markers; tool-call arguments
become references with a bounded path when present. Assistant text retains
up to 768 UTF-8 bytes plus an omission marker, with exact duplicate replies
collapsed. Historical custom notifications become markers. User messages and
recent rounds are not modified. Serializer retains full recent tool text;
images remain recoverable in original history for this text-only compactor.

Pruning is intentionally lossy, as requested. Facts omitted from older output
are recoverable from session history/artifacts. Instructions say to rerun only
safe read-only checks, never mutations or paid jobs. Pruning adds no model call
or subprocess. Fingerprint version invalidates earlier checkpoint strategies.

Native RTK integration delegates Bash command rewriting to `rtk rewrite` via
Pi exec with separate argv, a two-second timeout and cancellation. Pi executes
the resulting command once. Scope is Mantice/Fornace sessions; already-prefixed
commands are skipped. Recognized rewrite exit codes 0/3 apply; no match leaves
the command intact. An unavailable binary gives one warning and preserves
execution. RTK is an external binary dependency for output compression, not a
condition for gateway access or historical pruning. RTK_DISABLED=1 opts out.

## Verification and measurements

Reviewed 2026-09-06. Installed RTK reports `rtk 0.46.0`. Installed Pi SDK 0.85.1
types/source inspected for event mutation, context messages and serialization.
The existing standalone Pi RTK extension was read; `rtk -v init -g --agent pi
--dry-run` reported it already up to date and wrote nothing.

- Actual installed `rtk rewrite 'git status --short'` -> `rtk git status --short`.
- `rtk pipe --filter cargo-test` on synthetic 100 passing tests: exit 0,
  2040 input bytes -> 48 output bytes. No historical command was executed.
- Real-binary hook fixture confirms rewrite, no double wrapping and other
  providers untouched. Pruning fixture confirms immutable originals, exact user
  and recent-round preservation, full recent tool serialization, external kept
  context boundary and valid Unicode. No retained tests added.
- Typecheck and all 32 existing tests passed. Existing isolated Pi RPC overflow
  and SessionManager SIGKILL/checkpoint fixtures passed.
- Torchio chronological sample used in earlier receipts: 3,198,362 serialized
  bytes -> 632,516 (80.22% smaller), approximate 256 KB chunks 13 -> 3 excluding
  prior summary/instructions. All 47 user messages and the last 41 messages
  forming two rounds were compared exactly. 4,205 older non-user messages
  pruned. This is a sample measurement, not a fixed token-saving guarantee.

Official sources fetched successfully; initial guessed legacy source paths
returned HTTP 404, then repository tree resolved the current paths:
https://github.com/rtk-ai/rtk
https://raw.githubusercontent.com/rtk-ai/rtk/develop/src/cmds/system/pipe_cmd.rs
https://raw.githubusercontent.com/rtk-ai/rtk/develop/src/core/tee.rs

RTK pipe filters existing stdin without rerunning a command. Native command
rewriting prevents future output growth; historical pruning also removes the
large command/script arguments that RTK output compression does not address.
No RTK source was copied into this package.

Release selection and npm publication require separate evidence.
