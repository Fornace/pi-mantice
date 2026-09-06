# Bounded compaction inputs — 2026-09-06

## Incident and evidence

Torchio session ending `94b7f491`, cmux workspace 3 / surface 47, remained
blocked at 99.3% context. Manual and automatic compaction serialized the
whole history into one request and exhausted the same class chain.
Observed provider response: HTTP 400 `context_length_exceeded`,
`input_tokens: 1144092`, `max_input_tokens: 1050000`.
An earlier manual attempt reported 1136769 input tokens. Repeating the
unchanged request does not reduce its size. No policy rejection was retried.

## Change

Split oversized serialized history (including any previous summary) into
ordered UTF-8-safe parts of at most 256,000 bytes. Each successful summary
is carried into the next part. All input text is covered; no transcript is
deleted or rewritten. Commit one replacement compaction only after every
part succeeds. Preserve the original kept-entry boundary and token count;
sum usage across successful parts. Abort or policy rejection cancels the
whole operation without falling through to another compactor. Oversized
instructions or carried summaries fail explicitly rather than being cut.

This is a conservative byte budget, not a universal tokenizer guarantee.
Summaries are lossy by nature; retaining the original session file remains
essential. Intermediate summaries are not durable resumable checkpoints.
Existing transient-recovery runtime gating remains unchanged.

## Verification

- Typecheck and all 32 existing tests passed; no retained tests added.
- Existing real compaction-wire and session-wire checks passed.
- Ephemeral Unicode fixture: exact round-trip across seven chunks, bounded
  prompts, ordered carry, summed usage, preserved boundary, policy stop and
  cancellation without a partial result.
- Real isolated Pi 0.85.1 RPC fixture: oversized seed, truncated next turn,
  four bounded summarization requests (largest serialized messages 256818
  bytes), exactly one saved compaction and automatic continuation of the
  interrupted turn. Synthetic loopback only; no actual tools/provider jobs.

## Sources and versions

Reviewed 2026-09-06 04:00 UTC. Official compaction documentation fetched
HTTP 200 through Scrapling HTTP:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/compaction.md

Installed development Pi 0.85.1 types and extension completion wrapper were
read. Live Torchio process remains on Pi 0.84.4; plugin reload does not
upgrade that process. Official releases API returned v0.85.1 Sep 5,
v0.85.0 Sep 4, v0.84.4 Aug 28:
https://api.github.com/repos/earendil-works/pi/releases?per_page=3

Live uptake and successful Torchio compaction require separate verification.

## Live uptake verified 2026-09-06 09:23 UTC

Supersedes the pending uptake statement above. Selected local detached release
c505bc66098bcdc2c9a5f489c8c36bc65a1c7044 passed CI34010432235 and the real
Pi0.84.4 loopback probe before the existing Torchio process was reloaded.
The live UI then showed ordered compaction progress across18parts.

The original session JSONL contains hook-provided compactions at04:38:33.430UTC
(tokensBefore1023187, summary22808characters) and04:52:47.157UTC
(tokensBefore1021729, summary22870characters). Different kept boundaries were
recorded. Since the second,37assistant tool-use turns and10normal final replies
were saved; no error/length stop was present in that inspected interval.
At09:22UTC cmux showed6.8%context and a normal watcher acknowledgement.

Reload released sentia-inbox and eugeny-telemetry-sync-v3 at04:04:52UTC;
both were reclaimed at04:04:57UTC by the same PID17318. The visible SIGTERM
was the old watcher child exiting during reload, not loss of the session.
Telemetry heartbeats and normal assistant replies continued afterward.

Coordination scope: gateway/plugin repair and monitoring only. Ask the owning
agent to retry genuinely pending blocked requests within existing authority;
do not perform its research/crawls/UI work or resume deliberately paused goals.
Such a request was sent at09:23UTC; its response remains to be checked.

Current official cmux CLI contract fetchedHTTP200 via Scrapling, installed
CLI help inspected before coordination:
https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md
Pi release freshness recheck remains0.85.1/Sep5,0.85.0/Sep4,0.84.4/Aug28.
This proves this session's recovery, not indefinite fleet-wide reliability or
npm publication of the plugin.

09:24UTC coordination response completed normally at7.0%context. The owning
agent confirmed the telemetry watcher is healthy and no gateway-blocked request
remains pending. It explicitly preserved its deliberately paused goal and did
not restart stopped tasks. Root performed no sibling task work in this check.
