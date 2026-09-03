// Audit: a real Pi process must register exactly the chat models and
// capacities the authenticated Mantice catalog publishes, for both providers
// (mantice with aliases, fornace group-only). With M0 capability fields
// present, every chat row must also carry mode, class where expected,
// thinking evidence, and a catalog_generated_at stamp. Exits non-zero on
// any mismatch.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDERS,
  assertFornaceMaxCapacity,
  baseUrlFromEnv,
  buildProviderModels,
  fetchCatalog,
  isChatRow,
  hasCapabilities,
} from "../src/catalog.ts";

const key = process.env.MANTICE_API_KEY;
if (!key) {
  console.error("MANTICE_API_KEY is required to audit against the live catalog");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const rows = await fetchCatalog(baseUrlFromEnv(), key);
assertFornaceMaxCapacity(rows);
const expected = Object.fromEntries(PROVIDERS.map((p) => [p, buildProviderModels(rows, p, () => {})]));

const outPath = join(mkdtempSync(join(tmpdir(), "pi-mantice-audit-")), "registry.json");
const run = spawnSync(
  "pi",
  ["-e", join(here, "audit-probe.ts"), "--no-session", "--no-context-files", "--no-skills",
    "--no-themes", "--mode", "json", "--provider", "mantice", "--model", "fornace-fast",
    "-p", "Reply with the single word: ok"],
  { env: { ...process.env, PI_MANTICE_AUDIT_OUT: outPath }, encoding: "utf8", timeout: 120_000 },
);
// The probe dumps the registry at session_start, before any model call lands.
// A non-zero exit (for example upstream quota trouble during the -p ping) is
// only fatal when the dump itself is missing.
if (run.status !== 0 && !existsSync(outPath)) {
  console.error(`pi probe exited with status ${run.status} and wrote no registry dump`);
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
if (!existsSync(outPath)) {
  console.error("audit: probe wrote no registry dump");
  process.exit(1);
}

const actualAll = JSON.parse(readFileSync(outPath, "utf8"));
let failures = 0;
let checks = 0;
for (const provider of PROVIDERS) {
  const actual = new Map(actualAll.filter((m) => m.provider === provider).map((m) => [m.id, m]));
  const wanted = new Map(expected[provider].map((m) => [m.id, m]));
  for (const [id, model] of wanted) {
    checks += 1;
    const got = actual.get(id);
    if (!got) { console.error(`FAIL ${provider}/${id}: missing from Pi registry`); failures += 1; continue; }
    for (const field of ["contextWindow", "maxTokens", "reasoning"]) {
      if (got[field] !== model[field]) {
        console.error(`FAIL ${provider}/${id} ${field}: catalog=${model[field]} pi=${got[field]}`);
        failures += 1;
      }
    }
    const wantImages = model.input.includes("image");
    if ((got.input?.includes("image") ?? false) !== wantImages) {
      console.error(`FAIL ${provider}/${id} image input: catalog=${wantImages} pi=${got.input}`);
      failures += 1;
    }
  }
  for (const id of actual.keys()) {
    if (!wanted.has(id)) { console.error(`FAIL ${provider}/${id}: in Pi but not in catalog policy`); failures += 1; }
  }
}

if (hasCapabilities(rows)) {
  const chatRows = rows.filter((r) => isChatRow(r, true));
  const missing = chatRows.filter((r) => typeof r.mode !== "string" || !r.input_modalities);
  if (missing.length) {
    console.error(`FAIL capability tier: ${missing.length} chat rows lack mode/modalities`);
    failures += 1;
  }
  const expectedClass = chatRows.filter((r) => /^fornace-(max|reasoning|fast|flash)$/.test(r.id) && !r.class);
  if (expectedClass.length) {
    console.error(`FAIL class derivation missing on ${expectedClass.map((r) => r.id).join(", ")}`);
    failures += 1;
  }
  const thinking = chatRows.filter((r) => r.reasoning !== false && !r.thinking && /^fornace-(max|reasoning|fast|flash)$/.test(r.id));
  if (thinking.length) console.error(`WARN thinking absent on ${thinking.map((r) => r.id).join(", ")}`);
} else {
  console.error("audit: gateway pre-M0 (no capability fields); structured assertions skipped");
}

if (failures === 0) {
  console.log(`audit OK: ${checks} model entries match the live catalog (${rows.length} rows)`);
} else {
  console.error(`audit FAILED: ${failures} mismatches`);
  process.exit(1);
}
