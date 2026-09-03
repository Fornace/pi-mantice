// Catalog-to-Pi model translation for the Mantice gateway, with M0 capability
// fields. Single source of truth for the extension, the snapshot refresher,
// and the audit tool. Node >= 22.18 loads this file natively (erasable TS
// only: no enums, no namespaces).

import type { TextClass } from "./classes.ts";
import { classOf } from "./classes.ts";

export interface CatalogRow {
  id: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  effective_context_window?: number | null;
  owned_by?: string | null;
  mode?: string | null;
  class?: string | null;
  input_modalities?: string[] | null;
  output_modalities?: string[] | null;
  supports_tools?: boolean | null;
  thinking?: { modes?: string[]; efforts?: string[] } | null;
}

export interface CatalogPayload {
  data?: unknown;
  catalog_generated_at?: number;
}

export interface PiModelEntry {
  id: string;
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

// Conservative defaults only for capability-tier rows that omit a value the
// gateway genuinely cannot know; absence of the whole capability layer is
// handled by the legacy tier instead.
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const FORNACE_MAX_MIN_CONTEXT = 128_001;

export const PROVIDERS = ["mantice", "fornace"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_API_KEYS: Record<ProviderId, string> = {
  mantice: "$MANTICE_API_KEY",
  fornace: "$FORNACE_LLM_API_KEY",
};

export const PROVIDER_ALIASES: Record<ProviderId, boolean> = {
  mantice: true,
  fornace: false,
};

export const DEFAULT_BASE_URL = "https://llm.fornace.net/v1";

export function baseUrlFromEnv(): string {
  return process.env.MANTICE_BASE_URL ?? DEFAULT_BASE_URL;
}

// Legacy tier only: gateway-owned literals for deployments older than the M0
// capability fields. A gateway that answers with `mode` on any row uses its
// own structured truth and these lists are ignored.
const LEGACY_NON_CHAT_IDS = new Set([
  "embed", "fornace-embed", "text-embedding-v3",
  "image", "image-high", "image-lite", "image-max",
  "fornace-image", "fornace-image-high", "fornace-image-lite", "fornace-image-max",
  "image-edit", "fornace-image-edit",
  "video", "fornace-video", "video-edit", "fornace-video-edit",
  "video-dubbing", "fornace-video-dubbing",
  "reve-image", "transcription", "fornace-transcription",
]);

const LEGACY_REASONING_IDS = new Set([
  "fornace-flash", "flash", "fornace-max", "max", "fornace-reasoning",
  "reasoning", "fornace-llm", "llm", "fornace-llm-fast", "llm-fast",
  "kimi", "fast", "fornace-fast",
]);

const LEGACY_IMAGE_IDS = new Set([
  "fornace-vision", "vision", "eugeny-5.1-vision", "gemini-3-flash-preview",
  "gemini-3.5-flash", "gpt-5.5", "gpt-5.4-mini", "codex-gpt-5.6-test",
  "coding-plan", "gpt-coding-plan", "grok", "fornace-grok", "fornace-grok-fast",
  "fornace-max", "max", "kimi",
]);

export const PRETTY_NAMES: Record<string, string> = {
  "fornace-max": "Fornace Max",
  "fornace-fast": "Fornace Fast",
  "fornace-flash": "Fornace Flash",
  "fornace-grok": "Fornace Grok",
  "fornace-grok-fast": "Fornace Grok Fast",
  "fornace-vision": "Fornace Vision",
  "fornace-llm": "Fornace LLM",
  "fornace-llm-fast": "Fornace LLM Fast",
  "fornace-reasoning": "Fornace Reasoning",
  "fornace-image": "Fornace Image",
  "fornace-image-high": "Fornace Image High",
  "fornace-image-lite": "Fornace Image Lite",
  "fornace-image-max": "Fornace Image Max",
  "fornace-image-edit": "Fornace Image Edit",
  "fornace-video": "Fornace Video",
  "fornace-video-edit": "Fornace Video Edit",
  "fornace-video-dubbing": "Fornace Video Dubbing",
  "fornace-transcription": "Fornace Transcription",
  "fornace-embed": "Fornace Embed",
  kimi: "Kimi K3",
  max: "Max",
  fast: "Fast",
  flash: "Flash",
  reasoning: "Reasoning",
  llm: "LLM",
  "llm-fast": "LLM Fast",
  vision: "Vision",
  grok: "Grok",
  "coding-plan": "Coding Plan",
  "gpt-5.5": "GPT 5.5",
  "gpt-5.4-mini": "GPT 5.4 Mini",
  "gemini-3-flash-preview": "Gemini 3 Flash Preview",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "glm-5.2-ondemand-max": "GLM 5.2 On Demand Max",
  "glm-5.2-ondemand-fast": "GLM 5.2 On Demand Fast",
  "glm-5.2-ondemand-reasoning": "GLM 5.2 On Demand Reasoning",
  "eugeny-max-pilot": "Eugeny Max Pilot",
  "eugeny-v6": "Eugeny V6",
  "eugeny-5.1": "Eugeny 5.1",
  "eugeny-5.1-vision": "Eugeny 5.1 Vision",
};

export function prettyName(id: string): string {
  return PRETTY_NAMES[id] ?? id;
}

export function parseCatalog(payload: unknown): CatalogRow[] {
  const data = (payload as CatalogPayload)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Mantice /v1/models returned an unexpected payload: missing data array");
  }
  return data.filter((item) => typeof item?.id === "string" && item.id.length > 0) as CatalogRow[];
}

// Capability tier when the gateway emits structured modes (post-M0); legacy
// tier when it does not. Decided once per catalog.
export function hasCapabilities(rows: CatalogRow[]): boolean {
  return rows.some((row) => typeof row.mode === "string" && row.mode.length > 0);
}

export function isChatRow(row: CatalogRow, capability: boolean): boolean {
  if (capability) return (row.mode ?? "chat") === "chat";
  return !LEGACY_NON_CHAT_IDS.has(row.id);
}

export function isAliasRow(row: CatalogRow): boolean {
  return typeof row.owned_by === "string" && row.owned_by.startsWith("alias:");
}

export function isReasoningRow(row: CatalogRow, capability: boolean): boolean {
  if (capability) {
    return Boolean(row.thinking && (row.thinking.modes?.length || row.thinking.efforts?.length))
      || row.class === "reasoning";
  }
  return LEGACY_REASONING_IDS.has(row.id);
}

export function inputOf(row: CatalogRow, capability: boolean): Array<"text" | "image"> {
  if (capability) {
    const modalities = row.input_modalities ?? ["text"];
    return modalities.includes("image") ? ["text", "image"] : ["text"];
  }
  return LEGACY_IMAGE_IDS.has(row.id) ? ["text", "image"] : ["text"];
}

export function assertFornaceMaxCapacity(rows: CatalogRow[]): void {
  for (const id of ["fornace-max", "max"]) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) {
      throw new Error(`Mantice catalog is missing required ${id} metadata`);
    }
    const context = row.context_window;
    if (typeof context !== "number" || context < FORNACE_MAX_MIN_CONTEXT) {
      throw new Error(`${id} context_window must exceed 128000; received ${String(context)}`);
    }
  }
}

export function buildProviderModels(
  rows: CatalogRow[],
  provider: ProviderId,
  warn: (message: string) => void = () => {},
): PiModelEntry[] {
  const capability = hasCapabilities(rows);
  if (!capability && provider === "mantice") {
    warn(
      "[pi-mantice] gateway /v1/models has no capability fields; using the legacy "
      + "literal classifier. Upgrade the gateway (M0 capability catalog) for strict metadata.",
    );
  }
  const models: PiModelEntry[] = [];
  for (const row of rows) {
    if (!isChatRow(row, capability)) continue;
    if (!PROVIDER_ALIASES[provider] && isAliasRow(row)) continue;
    if (capability) {
      const missing = ["mode", "context_window", "max_output_tokens"]
        .filter((field) => row[field as keyof CatalogRow] == null);
      if (missing.length) {
        // A capability gateway that cannot describe one route must not poison
        // the whole catalog; but a silently defaulted window is the 128K
        // incident itself, so the row is skipped loudly, never guessed.
        if (row.id === "fornace-max" || row.id === "max") {
          throw new Error(`capability-tier catalog row "${row.id}" is missing ${missing.join(", ")}`);
        }
        warn(`[pi-mantice] skipping ${row.id}: gateway row missing ${missing.join(", ")}`);
        continue;
      }
    }
    const contextWindow =
      typeof row.context_window === "number" && row.context_window > 0
        ? row.context_window
        : DEFAULT_CONTEXT_WINDOW;
    const maxTokens =
      typeof row.max_output_tokens === "number" && row.max_output_tokens > 0
        ? row.max_output_tokens
        : DEFAULT_MAX_TOKENS;
    models.push({
      id: row.id,
      name: prettyName(row.id),
      reasoning: isReasoningRow(row, capability),
      input: inputOf(row, capability),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    });
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

// Compaction candidates: the configured classes resolved to registered model
// ids for this provider. Aliases (mantice provider) are preferred over group
// ids because they survive group renames.
export function compactionModelIds(rows: CatalogRow[], chain: TextClass[]): string[] {
  const wanted = new Set(chain);
  const found: { class: TextClass; id: string; isAlias: boolean }[] = [];
  for (const row of rows) {
    const klass = classOf(row);
    if (klass && wanted.has(klass)) {
      found.push({ class: klass, id: row.id, isAlias: isAliasRow(row) });
    }
  }
  const ordered: string[] = [];
  for (const klass of chain) {
    const matches = found.filter((entry) => entry.class === klass);
    const preferred = matches.find((entry) => entry.isAlias) ?? matches[0];
    if (preferred) ordered.push(preferred.id);
  }
  return ordered;
}

export async function fetchCatalog(baseUrl: string, apiKey: string): Promise<CatalogRow[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Mantice catalog fetch failed: HTTP ${response.status} from ${url}`);
  }
  return parseCatalog(await response.json());
}

export function rowsForSnapshot(rows: CatalogRow[]): CatalogRow[] {
  return rows
    .map((row) => ({
      id: row.id,
      context_window: row.context_window ?? null,
      max_output_tokens: row.max_output_tokens ?? null,
      owned_by: row.owned_by ?? null,
      mode: row.mode ?? null,
      class: row.class ?? null,
      input_modalities: row.input_modalities ?? null,
      output_modalities: row.output_modalities ?? null,
      supports_tools: row.supports_tools ?? null,
      thinking: row.thinking ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
