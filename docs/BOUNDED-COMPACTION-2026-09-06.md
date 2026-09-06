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
