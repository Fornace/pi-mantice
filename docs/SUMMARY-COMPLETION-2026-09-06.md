# Reject incomplete replacement summaries

Local source fix: session_before_compact wrapper now requires response.stopReason
stop before returning summary text to compactWithClassChain. Previously length
and toolUse could pass with nonempty text, allowing incomplete replacement context.
Error fallback remains; aborted still becomes AbortError and cancels the chain.

TypeScript typecheck passes. In-memory probe loaded actual extension and invoked
its registered compaction hook with fake ModelRegistry.complete: length/toolUse/
error followed by stop use only second summary; aborted makes one call and cancels;
stop accepts directly. Five scenarios pass, no network/provider calls. Snapshot
catalog used with MANTICE_API_KEY removed only from fixture process environment.
No retained fixture or tests added. Not committed, published or installed yet.

Reviewed current official Pi compaction documentation September6UTC:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/compaction.md
Installed Pi0.84.4 source confirms compaction replaces active conversation context
while preserving transcript. Research session4fd060cc independently hit two
one-token length stops near1048576 input tokens; global auto-compaction disabled.
Manual recovery compaction completed at00:21:28.186UTC. One continuation sent;
surface110 now generating again with5.2% context, down from99.9%. Final answer
completion still pending. All32 existing tests and typecheck pass. This source
change does not alter that already-loaded plugin or global settings.
