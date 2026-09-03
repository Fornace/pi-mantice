# pi-mantice architecture plan

Status: DRAFT FOR APPROVAL. Nothing in this document is built until Francesco says go.
Author: pi session 01a06499. Date: 2026-09-03. Sources reviewed same day:
`fornace-pi-models@a2a63f7`, `pi-frontier@9ae9fa1` (data, daily.yml),
Mantice `origin/main` (`src/routing/select.rs`, `src/routing/models.rs`,
`docs/client-error-contract.md`, `e17c9f4`, `9348934`, live `/v1/models`,
live `/admin/routing`), installed Pi 0.84.4 docs (`custom-provider.md`,
`compaction.md`, `models.md`, `settings.md`), incident notes in Obsidian.

## What already exists (build on, do not rebuild)

| Piece | State |
| --- | --- |
| Catalog sync | `fornace-pi-models` (unpublished, local path): live `/v1/models` → Pi provider models, snapshot fallback, fail-closed 128K guard, registry audit against live catalog |
| Class routes | Gateway already serves `fornace-max/reasoning/fast/flash` + `vision`, image, video, dubbing, transcription, embed rows |
| Frontier data | `pi-frontier` 1.2.0: deterministic daily rebuild from models.dev (Actions cron 03:17 UTC), 56 models with tier, cost, `max_input_tokens`, `modalities.input/output`, release dates, route table |
| Compaction hooks | Pi `session_before_compact` with custom summary + usage; `serializeConversation`; overflow-triggered retry compaction |
| Routing philosophy | Since `e17c9f4`: operator priority + fallback chain only. No card-based pre-flight exclusions. Real upstream rejections drive failover. The stream-error fix (`error_terminal_stream`, PR #10) ends mid-stream failures visibly instead of as silent empty successes |
| Modality tooling | `pi-banana` (image) and `pi-cavallo` (video) already consume gateway image/video rows through their own config |

## Core decisions

1. **One package, `pi-mantice`, absorbs `fornace-pi-models`.** Published to npm
   (name verified free), trusted publishing after a manual first publish per
   pi-package convention. `fornace-pi-models` repo is archived with a pointer.
2. **The gateway stays the only model truth.** Pi never hardcodes model sets
   again. Capability gaps are fixed by extending `/v1/models`, not by client
   literals.
3. **Classes are gateway route groups; selection inside a class is the
   gateway's reactive job.** pi-mantice does not re-implement routing policy.
   It maps gateway classes to Pi metadata (reasoning flags, thinking budgets,
   modality input lists) and surfaces what the gateway decided per turn.
4. **Hermes cron is not needed for frontier data.** pi-frontier's Actions
   schedule already keeps it current and deterministic. pi-mantice consumes it.

## Architecture

```
pi-frontier (data, daily)          Mantice gateway (truth, live)
        │                                │ /v1/models (+M0 fields)
        ▼                                ▼
     pi-mantice ── registers ──►  Pi providers mantice + fornace
        │   ├─ class model metadata (max/reasoning/fast/flash/vision)
        │   ├─ compaction summarizer via class policy (fornace-flash)
        │   ├─ overflow + failover transparency
        │   └─ /mantice-setup (onboarding for third-party gateways)
        ▼
 settings.json packages (atomic switch, version-pinned)
```

## M0. Gateway addition: honest capability fields on /v1/models

Mantice PR, merged through main like everything else. Additive JSON only; the
fornace-pi-models audit already fails closed on capacity drift.

Per model row, computed from the group's enabled deployments and cards, in the
same spirit as `group_capability_fields` (max ceiling) and
`effective_context_window` (circuit-aware right-now window):

```json
{
  "id": "fornace-vision",
  "mode": "chat",
  "class": "vision",
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"],
  "supports_tools": true,
  "thinking": {"modes": ["enabled", "disabled"], "efforts": ["low","medium","high","xhigh","max"]}
}
```

Rules:
- `mode` comes from the existing routing group `mode` field (`chat`, `image`,
  `video`, `audio`, `embed`...); it is operator-set, not inferred.
- Non-chat rows keep sane nulls and are explicitly non-conversational; clients
  stop guessing by id literal.
- `class` is optional operator metadata on the model group (new field,
  default derived: `fornace-max→max`, `fornace-reasoning→reasoning`,
  `fornace-fast→fast`, `fornace-flash→flash`, plus modality names). No new
  routing behavior reads it; it exists for clients.
- `thinking` aggregates what enabled deployments in the group accept (from
  cards/params), so Pi can expose only real levels.
- Version stamp: response gains `catalog_generated_at`; audits compare it.

Acceptance: live rows for all 57 models carry mode + modalities;
`fornace-pi-models` style audit extended to fail on missing fields; Rust tests
cover groups with mixed cards and quarantined circuits (effective window
omitted when all open, unchanged behavior).

## M1. pi-mantice v1: catalog, classes, metadata

Module layout (each ≤ 400 lines, erasable TS only):

```
extensions/mantice-models.ts   provider registration, refresh, fail-closed guards
src/catalog.ts                 /v1/models → Pi model rows (replaces literals)
src/classes.ts                 class → thinking map, budgets, compaction policy
src/summarize.ts               session_before_compact implementation (v1 core)
src/overflow.ts                message_end canonicalization (COMPACTS patterns)
src/frontier.ts                pi-frontier join: cost/tier/release evidence
test/*.mjs                     pure logic, no Pi needed
tools/audit.mjs                live registry vs authenticated catalog incl. M0 fields
tools/audit-probe.ts           dumps resolved Pi registry at session_start
```

Catalog behavior (inherited from fornace-pi-models, hardened):
- Live fetch at extension-factory time (Pi awaits it); snapshot fallback logs
  loudly; snapshot is committed in-repo and CI-refreshed, never invented.
- Fail closed: `fornace-max`/`max`/class rows with missing or ≤128K
  `context_window`, or missing `mode` after M0, abort registration with an
  actionable error naming the row (never a silent default).

Class metadata:
- `reasoning: true` and `thinkingLevelMap` built from gateway `thinking.efforts`
  per row; `input` from `input_modalities` (Pi supports text|image; video/audio
  rows are excluded from chat registration and reported to the tool packages).
- thinkingBudgets suggestions per class exported as a settings snippet, not
  auto-written (user-owned config stays untouched; `/mantice-setup` offers it).

## M2. Compaction through the flash class

`session_before_compact` handler:
1. Summarize the prepared span with `fornace-flash` (cheap, fast, gateway
   failovers internally; no client-side health guessing).
2. Return `{ summary, firstKeptEntryId, tokensBefore, usage }` so Pi records
   summarization cost in session totals.
3. On flash failure: fall back to `fornace-fast`; on second failure return
   `cancel: true` and notify. Never compact with the session's max-class model.
4. Overflow-triggered compaction (`reason: "overflow"`) takes the same path,
   which is exactly the 08-31/09-01 class of incident made recoverable.

Model-change transparency during a turn: Pi accounting stays on the alias
ceiling (stable by design). `message_end` attaches `responseModel` from the
provider body as a transient detail line (notify once per change, deduped) so
operators see luna→glm→k3 moves without context math changing.

## M3. Overflow and error contract alignment

- Gateway 400s are already canonical (`context_length_exceeded` with
  `max_input_tokens`, `no_compatible_route`, `routes_exhausted` etc.).
  `src/overflow.ts` maps provider-shaped messages to Pi's known patterns
  (guarded per custom-provider docs: provider-scoped, never matching
  rate-limit text) so auto-compaction fires exactly once.
- 503 `no_route_available` maps to Pi's retry path, never compaction.
- Media rows (image/video/embed/audio/dubbing) are registered only as
  capability data for pi-banana/pi-cavallo consumption; pi-mantice exposes a
  shared `getManticeModels()` import so those packages drop their own id lists.

## M4. First-install onboarding: `/mantice-setup`

Node tool in-repo (`src/setup.ts`, `pi registerCommand("mantice-setup")`
wrapper). For a gateway the user runs themselves (ADMIN_TOKEN + URL configured):
1. Read available upstream credentials from a documented env contract
   (`MANTICE_SETUP_PROVIDERS=json` file: kind, base_url, credential env names).
   No secret ever leaves the machine; tool posts the same shape the Providers
   console posts.
2. Probe each provider (`POST /admin/providers/probe`), discover models.
3. Classify discovered models into `max/reasoning/fast/flash` + modalities via
   pi-frontier join (tier, cost, context, release date); anything absent from
   frontier is offered but demoted to its own internal group, never into a
   class chain.
4. Emit a dry-run plan: groups, deployments with priority order (class best →
   fallback chain), aliases, tokens for issuance. Print full JSON.
5. Require the literal word `APPLY` + a `routing_revision` CAS check; publish
   via `POST /admin/routing/reset` once, validate response revision, re-read
   `/v1/models`, verify M0 fields, exit non-zero on any mismatch. Existing
   non-empty registries demand an explicit `--replace` flag; default refuses.
6. Never touch the Fornace production gateway (host blocklist includes
   llm.fornace.net unless `--allow-prod` with an interactive confirm).

## M5. Atomic install + rollout (incident-proof)

1. Build and fully verify in this unregistered directory.
2. `npm test`, `npm run audit` against live llm.fornace.net, real auto-discovery
   probe (`pi -e` AND installed-directory shape per pi-package skill).
3. Publish: one manual first `npm publish` (new package, OIDC impossible on
   first), then `npm trust github`, tag `v*` pipeline after.
4. Switch this machine: settings `packages` entry from the local path to
   `npm:pi-mantice@<exact version>`; reload every running Pi per the cmux
   protocol (escape if active, reload, verify footer `1.1M`); a fresh-process
   `pi --list-models` check must pass before reload storm starts.
5. Archive fornace-pi-models repo (pointer README), keep the last commit tag.

## M6. Documentation and memory

- README (install, setup, compaction policy, class table), CHANGELOG with the
  128K + cursor+200-error-as-content incidents as motivation receipts.
- Honcho `repo-pi-mantice` facts; Mantice repo note for M0; Obsidian decision
  note `decisioni/2026-09-0X-pi-mantice-class-catalog.md` linking the two
  incident notes.

## Testing matrix

| Layer | Check |
| --- | --- |
| Unit | class map, catalog parsing, fail-closed guards, thinking-level projection, setup planner (pure, fixtures) |
| Contract | Pi registry vs live /v1/models incl. mode/modalities/class; snapshot drift detection |
| Behavior | long-session overflow → compaction on flash with usage recorded; manual `/compact` parity; 503 retry not compaction; responseModel change notice |
| Onboarding | local throwaway gateway + provider stub (example.invalid servers) full setup dry-run→APPLY, refusal without `--replace` |
| Install | tarball + registry artifact load via real auto-discovery; version-pinned settings switch; rollback = repoint settings, one `/reload` |

## Risks and mitigations

- **Gateway field naming churn (M0 vs other sessions):** additive-only fields,
  clients tolerate absent-but-log; PR review lands M0 before pi-mantice v1
  ships the strict audit.
- **Cursor-style 200-with-error-content:** terminal contract fixes (PR #10,
  session 83) are the gateway's answer; pi-mantice treats empty-content 200s
  via Pi's normal retry and reports usage anomalies, never suppresses.
- **Compaction spend:** summarizing with flash class costs cents; guard:
  minimum token span before custom handler engages (reuse Pi's own threshold).
- **Frontier staleness for exotic models:** demotion rule keeps unknown models
  out of class chains; operators promote explicitly in gateway groups.
- **Settings churn during reload storm:** reload protocol is proven from the
  128K event (map exact surfaces, single escape, verify footers, keep the one
  busy agent's stash untouched).

## Non-goals

- No client-side route health/circuits (gateway owns it).
- No request-compatibility pre-flight in the client (deleted from the gateway
  deliberately; reactive is the contract).
- No new server-side cron for frontier data.
- No touching Hammersmith engines (already discovery-driven and correct).
- No rewriting banana/cavallo beyond consuming M1's shared model reader.

## Milestones and approval

M0 (gateway PR) → M1+M2+M3 (package v1: catalog, compaction, overflow) → M5
(publish + this machine switches) → M4 (setup tool for external gateways) → M6
(docs). v1 is not published without compaction and overflow behavior verified;
the switch never ships a half package (that was the migration incident).
Each milestone: tests green, coherent commits, merged to main through CI for
gateway changes, published tag for the package.
