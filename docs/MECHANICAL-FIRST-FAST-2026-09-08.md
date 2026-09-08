# Mechanical-first fast compaction

Implemented 2026-09-08, version 1.1.0. `/fast session` becomes stage one:
a deterministic, byte-bounded digest replaces the summarized span with zero
model calls and millisecond latency. Smart compaction stays Pi native
(`/compact`, manual or automatic) and receives the pruned payload.

The digest (`src/mechanical-compaction.ts`) retains, in priority order under a
64 KiB ceiling: header counts, user focus, the previous summary (24 KiB cap),
every user message as a chronological excerpt (progressive caps 16 KiB to
128 B, fair distribution, never the whole-section cut unless no cap fits),
each round's final assistant text as a 2048-byte conclusion, the tool-call
index with bounded paths, read/modified file lists (200 entries each),
deduplicated older assistant text excerpts (512 B, oldest cut first), and a
recovery note.
Split-turn prefixes are pruned and digested with the same rules. Extension
details record `mechanical: true`, version, counts and digest bytes. No LLM
usage is recorded because no LLM runs.

Removed: flash-chain summarization, chunking, part checkpoints and the
compaction wire fixture that pinned them. `supportsCompactionRecovery` moved
to `src/admission-recovery.ts` (still used by admission recovery).

Dead code fixed: `session_before_compact` mutations of `event.customInstructions`
are never read back by Pi 0.85.1 (manual and auto paths pass the local variable
to the summarizer). The PRUNING_CONTEXT injection never reached any request;
recovery markers now live in the pruned messages themselves. The wire fixture
proves pruning via message markers on the summarizer request.

New RTK tools: `fast_read` (rtk read minimal/aggressive, optional max-lines)
and `fast_write` (native write plus `rtk smart` two-line receipt). Registered
only when the rtk binary is on PATH; native read/write untouched.

## Measurements (read-only, real session JSONLs, 2026-09-08)

Bench: parse, buildContextEntries, prepareCompaction, prune, build digest.

| Session | JSONL | Span | Digest | Context estimate | Wall (load+digest) |
| --- | --- | --- | --- | --- | --- |
| payme 2026-09-05 | 22.3 MB | 816 msgs, 181K tokens | 37.1 KiB | 502,071 → ~29,983 tokens (94.0%) | 97 ms |
| mantice 2026-09-05 | 44.4 MB | 788 msgs, 139K tokens | 35.2 KiB | 264,826 → ~31,016 tokens (88.3%) | 143 ms |
| research 2026-09-05 | 95.1 MB | 337 msgs, 105K tokens | 39.2 KiB | 416,374 → ~18,281 tokens (95.6%) | 316 ms |

All three exceed the 80% context-reduction goal; the digest builder itself
runs in 1.7 to 3.1 ms. Kept-tail bytes use Pi's 20K keepRecentTokens default.

## Quality evaluation (flash model, payme session, 2026-09-08)

A flash model summarized the pruned span (the expensive reference, 111K
prompt tokens) and then compared both directions against the digest.

First digest revision (no round conclusions): judged HIGH risk; the decisive
late-session facts (incident closed, tester deployed and verified, completion
recorded) lived only in assistant text that 512-byte excerpts squeezed out.

Fix: each user round's final assistant text now gets a 2048-byte excerpt in a
`Round conclusions` section placed before the tool index, so recency survives
budget pressure. Re-evaluated:

- Digest vs AI summary: MEDIUM residual risk. Retained: incident root cause,
  affected IDs, core fixes, test results, infrastructure identifiers, major
  commits, final completion state. Lost: verbose reproducibility details
  (exact systemd/Undici workaround wording, browser-route coverage lists,
  completed.txt verification caveat) — all recoverable from the original
  JSONL by design.
- AI summary vs digest: the digest is STRICTLY BETTER on exact identifiers:
  production fix commit, entity/member/task IDs, version 2/3 command IDs,
  exact malformed payload timestamps, overlap mapping, and the final
  completion state, which the AI summary actually described incorrectly as
  still pending.

Conclusion: mechanical stage 1 keeps the cheap exactness an AI summary
loses, and its remaining losses are verbose details recoverable from history.
For maximum fidelity, stage 2 (`/compact`) still exists on the pruned input.

## Verification

- Typecheck and 25 unit tests pass (4 new digest tests: user retention,
  budget enforcement, progressive caps, file-list separation).
- `tools/verify-fast-wire.mjs` (CI: `test:fast-wire`): real Pi 0.85.1 RPC
  against a loopback provider. Proves `/fast session` appends a mechanical
  compaction with zero model calls, `/compact` runs Pi native on pruned
  input (pruning markers present on the summarizer request), and `fast_read`
  executes end to end through RTK. The rtk binary is installed in CI from
  the official musl release.
- Real-session proof on a copy of the live payme session (22.3 MB JSONL,
  502K tokens): `/fast session` via real Pi RPC completed in 51 ms with zero
  provider requests, appending a 40.7 KB mechanical digest for an 847-message
  span (98.0% span-token reduction; ~94% end-context reduction including the
  kept tail).
- `rtk read --level aggressive` on a 7.5 KB Rust file: 620 bytes (92%
  smaller); `rtk smart` returns a two-line summary in ~11 ms.
- Installed RTK 0.46.0; `rtk rewrite` still classifies cat/rg/ls/find/git.
