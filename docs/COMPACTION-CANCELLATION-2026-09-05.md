# Compaction cancellation is terminal

Reviewed 2026-09-05 against installed Pi 0.84.4 and official extension docs:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
Scrapling GET returned HTTP 200 at 18:22:28 UTC; raw extracted response is
/tmp/mantice-compaction-cancel-20260905.md.

Installed agent-session.js manual and automatic compaction paths invoke the
default compactor when the extension returns undefined. They stop on cancel:true.
The custom helper previously returned undefined for an aborted signal, and the
SDK wrapper discarded the distinction between error and aborted stop reasons.

The helper now returns cancel:true before work, between candidates, after a late
completion, and after an aborted request. A provider aborted stop reason becomes
AbortError and is also terminal even when the caller signal is not aborted.
No summary returned after cancellation is accepted for context replacement.
Ordinary service failures retain their existing class-chain fallback behavior.

Verification: 32 unit tests pass, including manual/threshold/overflow crossed
with pre-abort, rejected request, late success and provider AbortError. Each
scenario asserts no second request and no fallback notification. Typecheck and
real ModelRegistry compaction-wire test pass. Source files remain below400 lines.

This is source verification, not proof of installed-client rollout or the real
interactive cancellation lifecycle. Policy-error classification remains separate;
this patch does not classify arbitrary error messages or replay policy refusals.

## Real RPC cancellation gap (not resolved)

The opt-in reproducer `PI_TEST_COMPACTION_CANCEL=1 MANTICE_BIN=/path/to/mantice
npm run test:session-recovery` fails against installed Pi0.84.4: RPC abort
acknowledges success while a paused manual compaction continues, eventually
falling through to a successful default summary after the fixture provider's
three-second timeout. This is NOT passing cancellation lifecycle coverage.
The ordinary recovery gate does not enable this known-failing reproducer.

Installed rpc-mode.js dispatches abort to session.abort(). AgentSession.abort()
calls abortRetry(), agent.abort(), waitForIdle(), but not abortCompaction().
Manual compaction uses its separate _compactionAbortController. Therefore the
plugin never receives an aborted compaction signal on this RPC path. No installed
SDK source has been patched. An upstream fix or a supported lifecycle integration
is required before claiming this path is reliable.

Official RPC documentation GET200 at18:24:41UTC:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
Extracted raw response: /tmp/mantice-cancel-rpc-20260905.md. Docs describe abort
as stopping the current operation; actual installed behavior above is narrower.
Fixture first used an invalid command name; corrected to documented get_entries
before the meaningful failure. The reproducer asserts no saved compaction and
same-session continuation only if cancellation succeeds; those assertions remain
unreached on the failing installed version, not silently accepted.

## Verified upstream resolution in Pi0.85.1

Current upstream agent-session.ts GET20018:27:32UTC already includes
abortCompaction() and abortBranchSummary() in abort():
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/agent-session.ts
Raw extraction: /tmp/mantice-pi-session-current-20260905.md. npm registry
`npm view @earendil-works/pi-coding-agent version dist-tags --json` returned
version0.85.1/latest0.85.1. Isolated exact0.85.1 install source confirms the fix.

The same previously failing RPC reproducer PASSes on0.85.1: abort settles,
no compaction entry is saved, and the next prompt completes in the same session.
Dev dependency is now pinned exactly0.85.1 with regenerated lockfile. Recovery
fixture defaults to that repo-local Pi binary and always tests cancellation;
the former opt-in environment variable is no longer required. PI_TEST_BIN can
still explicitly select an older binary as a negative control.

All32 unit tests, typecheck, ordinary session-wire, compaction-wire and full real
Pi->Mantice recovery/cancellation fixture PASS locally. This supersedes the
unresolved source-test gap above, not the installed-client rollout limitation:
shared/global Pi remains0.84.4 and installed plugin remains5c8011d at this point.
No manual SDK patch or production registry changes. Gateway CI pin update and
safe-boundary fleet upgrade remain required.

npm installed-version help and official install docs reviewed GET20018:27:57UTC:
https://docs.npmjs.com/cli/v12/commands/npm-install/
Raw extraction /tmp/mantice-npm-install-20260905.md; installs used exact version,
ignore-scripts, no-audit/no-fund. The lockfile change includes the SDK dependency
tree update; it is not a handwritten source rewrite.
