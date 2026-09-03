// pi-mantice: Pi ⇄ Mantice gateway integration.
//
// Registers the mantice/fornace providers from the authenticated live
// /v1/models catalog (snapshot fallback, logged loudly), derives Pi model
// metadata from M0 capability fields (legacy literal tier for older
// gateways), compacts with the flash class chain, canonicalizes context
// overflow errors so Pi's auto-compaction recovers, and reports which
// backend model actually served each route.

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
  PROVIDERS,
  PROVIDER_API_KEYS,
  assertFornaceMaxCapacity,
  baseUrlFromEnv,
  buildProviderModels,
  compactionModelIds,
  fetchCatalog,
  parseCatalog,
  type CatalogRow,
  type ProviderId,
} from "../src/catalog.ts";
import { COMPACTION_CHAIN, classOf } from "../src/classes.ts";
import { compactWithClassChain } from "../src/summarize.ts";
import { createOverflowHandler, createResponseModelWatcher } from "../src/overflow.ts";

const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStore: false,
  maxTokensField: "max_tokens" as const,
};

const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "models-snapshot.json");
let catalogPromise: Promise<CatalogRow[]> | undefined;
const loggedWarnings = new Set<string>();

async function loadSnapshot(): Promise<CatalogRow[]> {
  const raw = await readFile(SNAPSHOT_PATH, "utf8");
  const rows = parseCatalog({ data: JSON.parse(raw) });
  assertFornaceMaxCapacity(rows);
  return rows;
}

async function resolveCatalog(): Promise<CatalogRow[]> {
  catalogPromise ??= (async () => {
    const baseUrl = baseUrlFromEnv();
    const key = process.env.MANTICE_API_KEY;
    if (key) {
      try {
        const rows = await fetchCatalog(baseUrl, key);
        if (rows.length === 0) {
          throw new Error(`Mantice catalog at ${baseUrl} returned zero models`);
        }
        assertFornaceMaxCapacity(rows);
        return rows;
      } catch (error) {
        console.error(`[pi-mantice] live catalog fetch failed: ${String(error)}`);
      }
    } else {
      console.error("[pi-mantice] MANTICE_API_KEY not set; cannot fetch live catalog");
    }
    const rows = await loadSnapshot();
    console.error(
      `[pi-mantice] WARNING: using committed snapshot (${rows.length} models); live catalog unavailable`,
    );
    return rows;
  })();
  return catalogPromise;
}

function providerModels(rows: CatalogRow[], provider: ProviderId) {
  const warn = (message: string) => {
    if (loggedWarnings.has(message)) return;
    loggedWarnings.add(message);
    console.error(message);
  };
  return buildProviderModels(rows, provider, warn).map((model) => ({ ...model, compat: COMPAT }));
}

export default async function register(api: ExtensionAPI) {
  let rows: CatalogRow[];
  try {
    rows = await resolveCatalog();
  } catch (error) {
    console.error(`[pi-mantice] catalog unavailable, providers registered empty: ${String(error)}`);
    rows = [];
  }

  for (const provider of PROVIDERS) {
    api.registerProvider(provider, {
      baseUrl: baseUrlFromEnv(),
      api: "openai-completions",
      apiKey: PROVIDER_API_KEYS[provider],
      models: providerModels(rows, provider),
      refreshModels: async () => providerModels(await resolveCatalog(), provider),
    });
  }

  const overflow = createOverflowHandler([...PROVIDERS]);
  let responseWatcher: ((message: {
    role: string; provider?: string; model?: string; responseModel?: string; stopReason?: string;
  }) => void) | null = null;

  api.on("message_end", (event, ctx) => {
    responseWatcher ??= createResponseModelWatcher(
      [...PROVIDERS], (message) => ctx.ui.notify(message, "info"));
    const message = event.message;
    const rewritten = overflow({ message: message as never });
    if (rewritten) return { message: rewritten.message as never };
    const assistant = message as { role: string; provider?: string; model?: string; responseModel?: string };
    if (assistant.role === "assistant") responseWatcher(assistant);
    return undefined;
  });

  api.on("session_before_compact", async (event, ctx) => {
    if (!rows.length) return undefined;
    const modelIds = compactionModelIds(rows.filter((row) => classOf(row) !== null), COMPACTION_CHAIN);
    if (!modelIds.length) return undefined;
    return compactWithClassChain(event, {
      chain: COMPACTION_CHAIN,
      modelIds,
      resolveModel: (id) => ctx.modelRegistry.find("mantice", id) ?? ctx.modelRegistry.find("fornace", id) ?? null,
      complete: async (model, context, options) => {
        const response = await ctx.modelRegistry.complete(
          model as never,
          context as never,
          options as never,
        );
        const text = (response.content ?? [])
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        return { text, usage: response.usage };
      },
      newSessionId: randomUUID,
      notify: (message, level = "info") => ctx.ui.notify(message, level),
    }, (messages) => serializeConversation(convertToLlm(messages as never)));
  });
}
