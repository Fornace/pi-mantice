# Manual fast commands

Added `/fast session [focus]`, `/fast preview`, `/fast status`, `/fast rtk`
and `/fast help`, with argument completions. Bare `/fast` displays help.

Session compaction invokes Pi's public ctx.compact API and existing Mantice
session_before_compact handler. Optional focus becomes customInstructions.
The command requires an idle Mantice/Fornace session without queued messages;
duplicate requests are guarded per session. Completion, failure and synchronous
exceptions clear the guard. Empty/already compact sessions produce a normal
notice. It does not send a continuation prompt or resume paused goals.

The guard also disables default Pi summarizer fallback for this command,
including small/unpruned input. Failed flash/fast candidates cannot silently
spend the max session model. Normal manual compaction behavior is unchanged.
Original transcript, user-message and recent-round pruning protections apply.

Preview reads the current compaction-aware branch and measures serialized bytes
before/after pruning, including the previous summary. Its chunks are an active
context estimate; Pi chooses the actual summarization/retained boundary.
Status reports model/context/summarizers and valid recent saved part progress,
explicitly conditional on identical input for reuse. Neither calls a model.

RTK checks version and `rtk rewrite` using separate argv and two-second timeouts,
then resets the native hook's unavailable state. It executes no Git command and
honors RTK_DISABLED=1. Missing/broken RTK produces a command error, without
changing the session model or gateway registry.

## Evidence

Reviewed official Pi extensions documentation successfully on 2026-09-06:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md

Installed Pi 0.85.1 command/context types, sessionEntryToContextMessages,
buildContextEntries and compaction callback implementations were read. RTK
0.46.0 installed help and source behavior were reviewed in the preceding RTK
receipt. No undocumented context mutation or private compaction method used.

Typecheck and 32 existing tests passed. Disposable real Pi RPC fixture used
only a synthetic loopback provider and the installed RTK binary. It verified
command discovery, help/status/preview/RTK/invalid-command notifications with
zero model requests; focused session compaction using only fornace-fast despite
fornace-max selected; one saved compaction; and failed summaries that leave the
saved compaction count unchanged, never call max, and clear busy state.

Initial fixture had only one round and correctly received Nothing to compact;
the multi-round fixture verified actual summarization. No retained tests added.
Release selection and npm publication require separate evidence.
