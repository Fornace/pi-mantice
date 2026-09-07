# Pre-execution drain admission recovery

Reviewed 2026-09-07 04:09–04:16UTC. Isolated gateway source based on fae91cc;
Pi source based on24a8708. Shared root WIP and live routing untouched.

## Cause and change

Raw socket rejection paths used generic503/gateway_error prose despite knowing
the socket had never reached parsing/dispatch. Native bounded retries could
exhaust during draining or worker saturation. The admission wrapper only knew
payload-budget/auth-storage codes, so it could not extend these waits.

A typed ConnectionRejection now covers drain, quiesce, unavailable worker pool,
full worker capacity and rejected worker queue. All emit503, Retry-After1,
X-Mantice-Admission:not-started-v1, retryabletrue/upstream_startedfalse, and
one of gateway_draining/gateway_quiescing/worker_pool_unavailable/
worker_capacity_unavailable. The worker and listener rejection functions accept
the enum, not an arbitrary status/message that could accidentally mark an
upstream failure. All existing callers are before request parsing or dispatch.

Pi adds these exact four codes to its existing admission allowlist. No changes
to retry mechanics: every HTTP attempt must prove unstarted; no output/start
event may have escaped; cancellation/settings remain respected; same captured
model/context/options; no new user turn, history diet or route switch.
Existing provider error forwarding still strips the marker. Bare503, old
draining prose, transport ambiguity, partial output and policy are not newly
replayed. This does not eliminate failures during process absence or establish
durable restart recovery; the gateway contract benefits compatible clients,
but this Pi uptake is not universal client adoption.

## Actual local verification

Rust1.97.0, Node26.0.0, Pi/pi-ai0.85.1.
Gateway releaseSHA2ed9b10f4fa9bbf75fa6a33eb883779c99ef31017011966a311f277ce6a1c15b.
Disposable /tmp/mantice-drain-recovery.6RiRM8/probe.mjs runs real Rust gateways
and Pi's admission stream behind a stable owned loopback proxy:
- workers2 saturated:503worker_capacity_unavailable→200;3provider/3quota total,
  including2original held requests; rejection adds no execution or charge.
- quiesce then authenticated resume:503gateway_quiescing→200;1provider/1quota.
- SIGTERM while1request active, then proxy to healthy replacement:
  503gateway_draining→200;2provider/2quota, original work finishes successfully.
All preserve byte-identical client uploads, context and one successful terminal.
These cases inject the clock wait (requested30000ms), not real30second sleeps.

queued.mjs separately queues a third request behind2running requests before
SIGTERM, then releases a worker. The queued request receives marked503draining
and never executes; bothoriginals200,2calls/2quota. DBdb2a6326-db24-49c1-98e9-1847f06bfed2.
Actual Pi CLI fixture (not injected clock) waited46528ms through markeddraining,
then completed:2HTTPcalls, same payload/sessionheader,1user/1assistant.
Session /tmp/mantice-drain-recovery.6RiRM8/sessions/
2026-09-07T04-14-17-447Z_a143cfba-bd06-4992-a941-3ba19e22bbdb.jsonl.

Existing19client controls plus hanging-evidence timeout, actual gateway payload
admission and upstream marker spoof controls pass; no added retry for spoof.
18retained Rust smokes, strict all-targetClippy/fmt/release/400line gate pass.
Pi32checks/typecheck and real session-wire/compaction-wire pass.
No new permanent tests. WorkerPoolUnavailable/disconnected queue are covered
by typed call-site review and compilation, not forced runtime fault injection.

## Current official evidence

Scrapling HTTP200 04:10:15–16UTC:
https://www.rfc-editor.org/rfc/rfc9110.html
Sections9.2.2,10.2.3,15.6.4 reviewed: distinguish known-unapplied work from
ambiguous POST failures; Retry-After is not proof of acceptance or execution.
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/custom-provider.md
CustomstreamSimple contract plus installed0.85.1 openai-completions.js read.
Past30day official source history04:13: 8b5899dc Sep3streamcompatibility and
256f6302 Sep2vllmPriority; no runtime upgrade or unrelated feature rewrite.
Initial history query used old providers path and returned[], corrected to
packages/ai/src/api/openai-completions.ts before drawing freshness conclusions.

https://cli.github.com/manual/gh_run_view
HTTP20004:13:55 plus installed gh2.92.0 help read. CI-only deploy remains required.
At receipt creation changes are LOCAL, not yet deployed or selected locally.
Fleet independent04:11:42 check:5exactpolicy errors unchanged, no new transient
failure eligible for coordinator input; no sibling mutations or policy replay.

## Source publication and local selection

Gateway ba1dd9e48e0e0703b284dbdcf95794a41c9ae68f pushedmain;
CI34082468632 running at04:18:23UTC. No production claim yet.
Pi d3c7f40db7b146c46af972e0934d8fe120a0723d pushedmain and
CI34082469621 passed04:16:38UTC, including clean install and both real wire gates.
New detached release installed under the existing immutable package-releases
scheme. npm12.0.2 ci --ignore-scripts --no-audit --no-fund installed130locked
packages; fresh typecheck/session-wire/compaction-wire all pass, worktreeclean.
Pi settings select d3c7f40 for future loads. Exactly one package path changed,
verified by full parsed-JSON equality after only the expected substitution.
Backup settings.json.mantice-drain-20260907T0418.bak and old24a8708 remain.
No existing sibling reload or task resume; process adoption is not established.
No npm publication or tag; source publication is not registry publication.

Official packages.md and npm-ci pages re-fetchedHTTP20004:16:55–56UTC:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md
https://docs.npmjs.com/cli/v12/commands/npm-ci
Installed pi list and npm ci help read. Local paths load in place; locked
ci preserves manifests and ignore-scripts avoids install-time execution.

## Verified production uptake

CI34082468632 and deploy34082642735 both succeeded for exact gateway
ba1dd9e48e0e0703b284dbdcf95794a41c9ae68f. Stage/deploy completed04:21:15UTC;
restart_ready_ms9500. Candidate, installed and loaded binary SHA256 match:
34abd26b9188b5492e380264b5caad87f8d98bfb9791a41f8f53d200e74afc02.
Read-only proof2026-09-07T04:21:57.301519UTC: activegreen PID2660078,
started04:21:01UTC, invocationca0bdda5746b4a5ebcfdef9b0cb9e46d.
Readiness HTTP200 raw body:
{"deployments":101,"providers":21,"status":"ok","uptime_seconds":56}
Routingrevision0a2f516419a8a2259f6eb2f3ed991c641e3105f4d8bcf240b03404965c86be8a,
inventory21providers/101deployments/44groups/20aliases/33fallbacks unchanged.
Payloadlimit268435456; reserved/waiting/deferred/rejected0.
No production overload or quiesce experiment, route write or inference replay.
Fleet04:20:05.004–04:20:08.652UTC:45panes,0changes,43reused,5policyerrors,
notificationFailedfalse. Client selectedd3c7f40, existing session adoption and
npm publication unverified; no all-healthy claim. Broad goal remains active.
