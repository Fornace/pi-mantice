// Deterministic join with the pi-frontier snapshot (rebuilt daily by its own
// Actions cron). Used by /mantice-setup (M4) and to annotate classes with
// current frontier evidence. Never invents entries: models missing from the
// snapshot return null and the caller demotes them.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

export interface FrontierModel {
  model_key: string;
  provider: string;
  family?: string;
  tier?: string;
  input_cost?: number;
  output_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  modalities?: { input?: string[]; output?: string[] };
  release_date?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  open_weights?: boolean;
}

let cache: FrontierModel[] | null = null;

export function frontierModels(): FrontierModel[] {
  if (cache) return cache;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("pi-frontier/data/frontier");
    cache = JSON.parse(readFileSync(resolved, "utf8")) as FrontierModel[];
    return cache;
  } catch (error) {
    throw new Error(
      `pi-frontier snapshot unavailable: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export function findFrontier(modelKey: string): FrontierModel | null {
  return frontierModels().find((model) => model.model_key === modelKey) ?? null;
}

export function bestOfTier(tier: string, needs: { tools?: boolean; vision?: boolean } = {}): FrontierModel | null {
  const candidates = frontierModels()
    .filter((model) => (model.tier ?? "").toLowerCase() === tier)
    .filter((model) => !needs.tools || model.tool_call === true)
    .filter((model) => !needs.vision || (model.modalities?.input ?? []).includes("image"));
  if (!candidates.length) return null;
  return candidates.sort((left, right) =>
    (left.input_cost ?? Infinity) - (right.input_cost ?? Infinity)
    || String(right.release_date ?? "").localeCompare(String(left.release_date ?? "")),
  )[0];
}

export function classifyUpstream(upstreamModel: string, providerName?: string): FrontierModel | null {
  const models = frontierModels();
  const exact = models.find((model) => model.model_key === `${providerName}/${upstreamModel}`);
  if (exact) return exact;
  const suffix = upstreamModel.toLowerCase();
  return models.find((model) => model.model_key.toLowerCase().endsWith(`/${suffix}`))
    ?? models.find((model) => (model.model_key.split("/").pop() ?? "").toLowerCase() === suffix)
    ?? null;
}
