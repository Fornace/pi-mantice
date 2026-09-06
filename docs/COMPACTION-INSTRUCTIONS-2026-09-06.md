# Preserve recovery instructions in custom compaction

Reviewed 2026-09-06. Official live documentation:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md

Scrapling HTTP response: 200 GET, 2026-09-06 02:59:57 Europe/Rome.
Extract retained at /tmp/mantice-compaction-docs.6lgP04/extensions.md.
The `session_before_compact` example exposes `customInstructions`; `ctx.compact`
documents passing those instructions into the summarization operation.
Installed development SDK: Pi 0.85.1; host runtime: Pi 0.84.4.
Both installed extension type declarations include this optional string.

The custom class-chain handler previously omitted customInstructions from its
event type and prompt. Thus `/compact Preserve ...` could succeed without ever
passing the requested preservation constraints to the summary model.

The handler now forwards the optional instructions verbatim into the prompt
for every class-chain attempt. Empty/whitespace-only instructions leave the
old prompt unchanged. Previous summary, conversation, retained-entry identity,
usage, cancellation, model selection, and automatic/manual fallback policy
are unchanged. No provider policy bypass, routing change or spending expansion.

Verification: typecheck and all existing 32 tests passed. An ephemeral direct
handler probe exercised first-route failure followed by fallback success,
asserting exact multiline instructions in both outgoing prompts, previous
summary retention, and unchanged firstKeptEntryId. Blank-instruction prompt
equivalence also passed. No provider calls and no retained test file added.

Source changes alone do not update already-loaded Pi extensions. This change
must be included in a staged release and adopted at a safe session checkpoint.
The separate automatic-compaction all-class-failure cancellation remains open.
