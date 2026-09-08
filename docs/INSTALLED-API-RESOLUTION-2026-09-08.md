# Installed API resolution audit

Date: 2026-09-08
Runtime: Pi 0.85.1, Node 26.0.0, npm 12.0.2 on macOS.
Scope: extension loading, API resolution, admission transport, package verification.

## Finding

The initial success claim after `0fdd045` was premature. `pi --help` proved
factory initialization, while API modules remained deferred until inference.

Pi provides selected core imports through its extension loader aliases,
including the root `@earendil-works/pi-ai` and `/compat`. Arbitrary `/api/*`
subpaths still require resolution from the extension's dependency environment.
The host's nested copy does not make those subpaths available everywhere.
The bundled CLI uses virtual modules. The unbundled `dist/cli.js` uses aliases;
an additional negative control there resolves the subpath to the invalid
`dist/compat.js/api/openai-completions`. Both distributions require the same
host-owned factory boundary used by the repair.

The original explanation attributed the failure to import-only exports and
CommonJS. That alone does not explain the measurements: both failing revisions
work through Pi's loader when a local `pi-ai` peer is present. The development
dependency masked the distributed-package failure.

## Controlled reproduction

Each revision was extracted with `git archive` outside the repository. The
existing `tools/verify-session-wire.mjs` drove the real Pi CLI against loopback.

| Revision | Local Pi peer | Result |
| --- | --- | --- |
| `566f49c` | Absent | Factory fails in the static admission transport import |
| `0fdd045` | Absent | Factory loads; first request fails in the deferred API import |
| `487c3b1` | Absent | Three CLI requests complete, including persisted-session resume |
| `566f49c` | Present, controlled development simulation | Same CLI checks pass |
| `0fdd045` | Present, controlled development simulation | Same CLI checks pass |

The repaired implementation uses `openAICompletionsApi()` and
`openAIResponsesApi()` from the host-provided `/compat` entrypoint. Their internal
relative imports resolve within Pi's bundled package. Admission recovery receives
that exact completions function as an argument. Its type-only import is erased.
There is no added core dependency, private `dist` import, provider substitution,
or API-resolution fallback.

## Verification corrections

Both existing wire fixtures omitted `max`, which `assertFornaceMaxCapacity`
requires. Their output checks allowed a catalog failure followed by the committed
snapshot to pass. The fixture catalog now supplies `max`; the session fixture also
supplies `mode`. Both scripts fail if Pi emits a Mantice diagnostic.

`npm run verify:package` runs those existing scripts from the npm tarball in a
temporary directory without bundled dependencies, using the checkout's exact Pi
binary as host. CI and publishing both run this command. The verifier records the
actual tarball SHA-512 and checks its file inventory. It reads the generated
artifact directly: npm 12.0.2's `pack --json` output is a keyed object, while the
initial verifier incorrectly expected an array.

No new test suite was added. The existing 25 tests, typecheck, session wire,
compaction wire and packed-artifact wire checks pass. The new packed gate also
rejects `0fdd045` with the same bundled Pi binary used for the passing check;
a separate unbundled-host control fails at its alias-appended path.

## Admission behavior

A disposable RPC exercise used the extracted package through settings-based
auto-discovery, a complete loopback catalog, and no local Pi peers. Native retries
were set to zero so they could not conceal the wrapper's behavior.

- Marked, unstarted 503: two requests, 30,435 ms apart; byte-identical payload,
  same session header, one user message and one final assistant message.
- Cancel during the actual timer: abort completed in 27 ms; one HTTP request,
  one aborted assistant message.
- Unmarked 503, `upstream_started: true`, explicit retry veto, policy rejection,
  partial streamed output, and retries disabled: one request and a terminal error
  each; no admission-wait notification and no wrapper replay.
- Ordinary completions and the `fornace` provider alias complete normally.
- Six catalog models load without a Mantice warning. Astra retains Responses;
  other routes retain Chat Completions.

These checks retain the existing admission contract. They do not claim a generic
restart/replay policy or new admission support for Responses.

## Installed verification before release

Fresh Pi processes used normal global package auto-discovery:

- All five originally missing `mantice/fornace-*` routes are present.
- Live `fornace-fast` and `fornace-astra` return text deltas and terminal `stop`.
- Live `fornace-max` executes one requested `printf` Bash call and completes the
  tool-result roundtrip with `toolUse`, then `stop`.
- A byte copy of the reported session resumes with Astra and 422 active messages.
  No prompt was submitted to that copy. The original session SHA-256 remained
  `ec2d4a1360b30915eaee681a8df0d64823f68bbc933c838c57fda3788b177d09`.
- Production routing and the Pi runtime installation were unchanged.

Local raw receipts are under `/tmp/pi-mantice-load-audit/`:
revision wire logs, `fixed-outcomes.json`, `fixed-calls.json`, and
`live-outcomes.json`. They are disposable evidence, not runtime dependencies.

Version 1.1.1 is prepared for the existing main-bound tag publishing workflow.
Publication, installed-artifact verification and running-session uptake remain
separate from these pre-release measurements.

## Sources

- [Pi 0.85.1 release, 2026-09-05](https://github.com/earendil-works/pi/releases/tag/v0.85.1)
- [Exact-version extension loader](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/loader.ts)
- [Package dependency contract](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md#dependencies)
- [Exact-version API lazy helper](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/lazy.ts)

The release page and latest release API were checked live on the audit date;
the loader and API behavior were inspected in the installed 0.85.1 distribution.
