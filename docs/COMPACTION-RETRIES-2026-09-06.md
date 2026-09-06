# Bounded transient recovery for custom compaction

Reviewed 2026-09-06. Official source fetched through Scrapling HTTP:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/utils/retry.ts
Response: HTTP200 GET at03:06:03 Europe/Rome. Extract retained at
/tmp/mantice-compaction-docs.6lgP04/retry.txt.

Installed development SDK/AI0.85.1 and host Pi0.84.4 inspected. The public
retryAssistantCall helper performs bounded transient-response retries and
cancellable backoff. Default Pi summarization uses it; custom registry.complete
does not invoke that outer helper. Pi's automatic compaction cancel branch sets
aborted=true and willRetry=false, bypassing default summarization entirely.

The custom hook now uses retryAssistantCall for each summary model. It reads
persisted global/project retry settings via SettingsManager at compaction time,
honoring ctx.isProjectTrusted(). It never writes those settings. SDK in-memory
overrides not persisted to settings are not visible through this API. Defaults
are the SDK defaults, not an additional hardcoded retry budget.

Retries remain on the same model and retain request options, scoped identity,
instructions, and cancellation signal. After transient retries are exhausted,
the existing flash/fast class fallback policy applies. Recognized machine
policy identifiers instead raise a terminal CompactionPolicyError and prevent
both retries and class fallback. Identifier matching is conservative and does
not claim comprehensive classification of arbitrary provider prose.

Existing incomplete-summary rejection remains: length/toolUse/error cannot be
committed as replacement context. The SDK retry helper does not retry arbitrary
thrown exceptions; those retain existing class-fallback behavior. All-class
failure still cancels automatic compaction. This is not durable outage recovery.

Verification without provider calls:
- typecheck and32 existing tests pass;
- existing real ModelRegistry loopback compaction-wire passes;
- direct helper probe:503 then success, bounded/disabled retry, auth/quota
  failures not retried, abort before call/during backoff, four policy identifiers
  terminal, no class fallback on policy;
- actual registered hook with isolated persisted maxRetries1/baseDelayMs1:
  synthetic503 then stop succeeds on same model, custom instructions preserved;
  synthetic policy response cancels with exactly one call.

Synthetic response evidence: stopReason=error/errorMessage='503 gateway draining'
followed by stopReason=stop/text='Complete summary'. Policy probe used
stopReason=error/errorMessage='503 wrapper content_policy_violation'. No actual
upstream response, prompt, credential, production registry or running session
was used by these probes. Added explicit pi-ai peer/dev dependency; no package
version upgrades. Existing staged release remains unchanged until staged uptake.
