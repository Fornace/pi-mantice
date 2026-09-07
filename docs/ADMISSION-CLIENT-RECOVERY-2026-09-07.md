# Client recovery for verified pre-upstream admission errors

Reviewed September 7, 2026, 03:39–03:53 UTC.
Gateway parent fc2ccbe; isolated pi-mantice parent ed6dd09.
Neither application work nor live routing is changed.

## Failure and chosen recovery boundary

Pi 0.85.1 owns its immediate agent retry and compaction loops.
agent_end is not settled: an independent retry there can duplicate continuation.
agent_settled is the supported settled observation, not a same-turn retry API.
Sending a synthetic user message is unnecessary for a rejected upload.

The extension now wraps the existing pi-ai Chat Completions transport for
Mantice/fornace on stable Pi>=0.85.1, with persisted retries enabled and a
caller AbortSignal. Older/unknown versions do not import the new transport.
It keeps the original logical request alive through explicitly unstarted
admission failures, waiting30–60s with jitter before a new attempt. There is
no attempt-count ceiling while this narrow condition remains true; cancellation
or any other error ends this added loop. No idle/session-start auto-resume,
new user message, route mutation, context pruning, or background worker.

## Evidence required for each HTTP attempt

- HTTP503, no redirect, no x-should-retry:false.
- Gateway-only X-Mantice-Admission:not-started-v1 response marker.
- Full bounded JSON error with type gateway_error, recognized code
  request_capacity_unavailable or upload_authentication_unavailable,
  details.retryable=true and details.upstream_started=false.
- The final pi-ai error independently has the exact503 structured wrapper/code.
- No start/content event was emitted and the failed assistant has no content.
- Every underlying SDK HTTP attempt met the same pre-upstream condition.
  A transport exception or any unknown response vetoes this additional replay.

The Rust intake constructor adds the marker only to those two pre-upstream
responses. Ordinary upstream rejections drop headers in upstream_rejection_response.
Owned spoof verification confirms an upstream cannot pass this marker through.
This is a transport-origin marker, not a cryptographic signature. The configured
gateway connection and its TLS trust remain the authority boundary.

Raw controlled admission body:
{"error":{"code":"request_capacity_unavailable","details":{"retryable":true,"upstream_started":false},"message":"request capacity temporarily unavailable; retry upload","type":"gateway_error"},"type":"error"}

Error inspection reads at most4096bytes, with1s timeout and strict UTF-8/JSON.
The SDK's original body remains available on every rejected classification.
Clone cancellation is not awaited before returning the original response:
ReadableStream tee cancellation can otherwise wait for that same consumer.
Retry-After is not shortened; invalid or >1hour advice keeps normal handling.
A UI notification failure never changes request execution. No prompts, tokens,
credentials, or error bodies are sent to a classifier by this path.

## Actual verification

Pi-ai0.85.1/OpenAI SDK6.40.0/Node26.0.0.
Disposable19wire cases plus hanging-body evidence timeout pass:
two admission codes recover after4failures/5HTTPcalls, one final successful
assistant; byte-identical uploads/session identity, original context unchanged.
Payload hooks run5times, successful response hook once. Same-route ordinary
success, missing marker, policy, accepted=true, string false, request echo,
oversized/malformed body, wrong status, long Retry-After, partial output,
mixed transport/503, abort, disabled retries, missing signal and UI failure
retain their respective boundaries. Hanging clone exits1002–1003ms and cancels.

Real Rust release hash:
cfcec73d7e57b43e6e4b48db1c2880527b16aaaa781f58b85579546ee2d943b5
Four held requests fill the payload budget. Fifth receives marked503 before
any provider call/quota charge; client waits, holders release, retry succeeds200.
Final5providercalls/5charges total, statuses[503,200], identical retry bytes.
Owned DB e694c36c-c07c-40a8-ad76-ea386422dedf.
Upstream spoof case: provider emits identical marker/code; downstream marker
is absent, client makes zero added admission retries, one provider call.
The first fixture incorrectly returned nonstream JSON to a streamed request,
yielding the correct502 terminal-missing error; corrected mock SSE passes.

Real Pi0.85.1 CLI loaded the candidate extension in an isolated configuration,
with no other extensions/tools/skills, no real credentials and loopback only.
First request503 at03:49:59.504UTC; second succeeds after47894ms real delay.
Saved transcript has exactly1user message and1successful assistant message;
no intermediate failure message, no injected continue, identical payload/header.
Session33333333-3333-4333-8333-333333333333.
Disposable fixtures /tmp/mantice-admission-client.FTkXZQ/{probe,gateway,pi}.mjs.

Existing32extension checks, typecheck, real session-wire and compaction-wire
pass. The typecheck previously mapped coding-agent to an absolute Homebrew
installation, causing duplicate private EventStream declarations; removed the
machine-specific mapping so both packages resolve from pinned local dependencies.
No casts suppress that discrepancy. Gateway18smokes/fmt/strictClippy/build pass.
No permanent tests were added. All touched source files remain below400lines.

## Scope and outstanding rollout

Source was verified locally at receipt creation; CI/deployment and installed
extension uptake must be checked separately. GitHub source is not npm publication.
Fleet03:50:09UTC unchanged:5explicit policy blocks remain unresolved.
Surface84 publication owner03:52:22UTC is idle with blank draft and completed
read-only audit; not editing extension source. Its reported remaining dependency
is npm trusted-publisher authorization; this is not independent npm config proof.
Generic durable client action runner, restart recovery, ambiguous accepted work,
and old terminal-policy sessions remain outside this narrow added transport loop.

## Official and installed evidence

- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
  HTTP20003:39:37UTC: agent_end versus agent_settled, custom messages/control APIs.
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/custom-provider.md
  HTTP20003:40:48UTC: streamSimple and event lifecycle; pinned installed
  provider-composer, model-runtime, error-body, event-stream, lazy and
  openai-completions source independently inspected.
- Official past30-day agent-session history03:39UTC includes Sep3 cancellation
  fix bea67d90 and Aug25 queued custom-message ordering fix240eb29.
- Official past30-day openai-completions history03:50UTC includes Sep3 stream
  compatibility fix8b5899dc and Sep2 optionalvllmPriority256f6302.
  No runtime upgrade or unrelated option change performed.
- https://cli.github.com/manual/gh_run_view HTTP20003:53:06UTC;
  installed gh2.92.0 help and exact-source CI/deploy workflows inspected.
