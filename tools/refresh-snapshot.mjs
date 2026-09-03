// Regenerates extensions/models-snapshot.json from the live authenticated
// Mantice catalog. The snapshot is only an offline fallback for Pi startup;
// the live catalog always wins when reachable.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFornaceMaxCapacity,
  baseUrlFromEnv,
  fetchCatalog,
  hasCapabilities,
  rowsForSnapshot,
} from "../src/catalog.ts";

const key = process.env.MANTICE_API_KEY;
if (!key) {
  console.error("MANTICE_API_KEY is required to refresh the snapshot");
  process.exit(1);
}

const baseUrl = baseUrlFromEnv();
const rows = await fetchCatalog(baseUrl, key);
assertFornaceMaxCapacity(rows);
if (rows.length === 0) {
  console.error(`Catalog at ${baseUrl} returned zero models; refusing to overwrite snapshot`);
  process.exit(1);
}
if (!hasCapabilities(rows)) {
  console.error(
    "[pi-mantice] WARNING: gateway has no capability fields yet (pre-M0); snapshot stores legacy shape",
  );
}

const snapshot = rowsForSnapshot(rows);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "models-snapshot.json");
await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`Snapshot written: ${snapshot.length} models -> ${out}`);
