# npm publication source guard and account-access boundary

Reviewed2026-09-07 04:24–04:38UTC. Root owns release source guard; packaging
session b4f23294/workspace16/surface84 remains the existing publication partner.

## Live evidence and coordinated correction

npm12.0.2 registry query still returns version1.0.0,
gitHead d74f3af69092a81fa8cf9a4f7d481c30e930c083,
dist-tags latest1.0.0, modified2026-09-03T14:17:14.498Z.
Both local npm whoami and npm trust list pi-mantice returned401.
Raw trust-list response:
{"success":false,"error":"You must be logged in to publish packages."}
Credentials transition directory inspected first; no secret values printed.
This proves the CLI lacks effective authentication, not that trust is absent.
Browser connector has no browser; nativeChrome access twice returned pending
Computer Use permissions. Browser login state and private npm settings unknown.
No login, account/trust permission change, publish, tag or rerun performed.

Independent read-only review of Publish33768229739 attempt3 confirms:
v1.0.1 at a8f8d701783d80c730d13b6ff7f7525afe941439, only publish failed
after source validation and provenance creation. Raw rejection:
E404 PUT https://registry.npmjs.org/pi-mantice — not found or no permission.
E404 does not uniquely identify missing trusted publisher; exact npm version
was absent from that run's logs. Maind3c7f40 is18commits ahead of that tag.
Rerunning that immutable old workflow cannot distribute current fixes.

Root sent a scoped handoff correction04:31UTC; surface84 returned ACK,
accepted no stale rerun/no duplicate source changes, and kept its goal achieved.
Direct recheck04:35 (>3minutes after send) retained ACK with no gateway error.
Its old session incurred a reported120Ktoken cache miss for this coordination;
the read-only subagent inspection itself did not send session input.

## Future release guard

.github/scripts/check-release.mjs validates version-tag equality, checkout/event
identity, remote main equality and clean tracked source. Git child processes
request15s timeout; Node may wait if a child handles SIGTERM without exiting.
publish.yml calls it before validation and again immediately before npm publish,
and records exactNode/npm versions. No credential or permission policy changed.
This protects future workflows containing the guard; historical tag workflows
are not retrofitted. It is not an atomic lock against main changing afterward.
Publications are still CI-only. Current source needs a fresh version/tag after
effective package authorization is established; never move the old tag.

Eight disposable function cases pass, including stale a8f8d7 vs d3c7f40.
Actual CLI refused dirty tracked source before publication. YAML parses and
contains both guard calls; syntax/typecheck pass. Fixture:
 /tmp/pi-mantice-release-guard.789ygw/probe.mjs
No new permanent tests. npm pack --dry-run --ignore-scripts reports35files,
43040compressed/157073unpackedbytes; admission modules included, CI files not
shipped. npm12 JSON is package-name-keyed, not the previously assumed array;
corrected the read-only jq query after inspecting keys, no artifact published.
At receipt creation source is local; GitHub CI and post-commit checks pending.

## Official evidence

Scrapling HTTP200 retrievals, installed command help/source read:
04:24:14–15 https://docs.npmjs.com/trusted-publishers/
and https://docs.npmjs.com/cli/v12/commands/npm-trust
Main guide supports up to10publishers and Sep3stage-by-default permissions;
CLI reference still says one. Do not revoke a publisher based on that stale
sentence. Both require effective account/package authorization.
Installed npm12.0.2 trust/list.js confirms GET /-/package/<name>/trust.

04:30:42 https://docs.github.com/en/actions/reference/workflows-and-actions/variables
04:30:43 https://docs.npmjs.com/cli/v12/commands/npm-publish
04:34:34 https://nodejs.org/api/child_process.html
04:34:35 https://git-scm.com/docs/git-ls-remote
Node26.0.0/Git2.54.0 installed; source guard uses argument arrays, no shell.
Past30day npm/cli source recheck: Sep3c9876d7 provenance-file precedence,
Aug31b016aa2 persistent allow-scripts environment; neither justifies recategorizing
the observed401 or changing this workflow's provenance mode. Trust/list path
history returned[]; initial outdated single trust.js path also returned[].
Goal remains active; publication awaits authenticated settings verification,
not another blind failed release attempt. Five historical policy panes remain
a separate unresolved gateway issue.
