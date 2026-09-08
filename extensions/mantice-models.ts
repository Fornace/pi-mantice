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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  isRetryableAssistantError,
  lazyApi,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  PROVIDERS,
  assertFornaceMaxCapacity,
  baseUrlFromEnv,
  buildProviderModels,
  fetchCatalog,
  parseCatalog,
  type CatalogRow,
  type ProviderId,
} from "../src/catalog.ts";
import { createOverflowHandler, createResponseModelWatcher } from "../src/overflow.ts";
import { pruneSummaryToolResults, PRUNING_CONTEXT } from "../src/summary-pruning.ts";
import { registerSessionIdentity } from "../src/session-identity.ts";
import { registerRtk } from "../src/rtk.ts";
import { serializeSummaryHistory } from "../src/summary-serialization.ts";
import { registerFastCommands } from "../src/fast-commands.ts";

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

const COMPLETIONS_API = lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"));
const RESPONSES_API = lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses"));

function providerModels(rows: CatalogRow[], provider: ProviderId) {
  const warn = (message: string) => {
    if (loggedWarnings.has(message)) return;
    loggedWarnings.add(message);
    console.error(message);
  };
  return buildProviderModels(rows, provider, warn).map((model) => ({
    ...model,
    ...(model.api === "openai-responses" ? {} : { compat: COMPAT }),
  }));
}

export default async function register(api: ExtensionAPI) {
  registerSessionIdentity(api);
  let admissionContext: ExtensionContext | undefined;
  api.on("session_start", (_event, ctx) => { admissionContext = ctx; });
  api.on("session_shutdown", () => { admissionContext = undefined; });
  const admission = supportsCompactionRecovery(VERSION)
    ? await import("../src/admission-recovery.ts") : undefined;
  const rtk = registerRtk(api);
  let rows: CatalogRow[];
  try {
    rows = await resolveCatalog();
  } catch (error) {
    console.error(`[pi-mantice] catalog unavailable, providers registered empty: ${String(error)}`);
    rows = [];
  }

  for (const provider of PROVIDERS) {
    const runtimeModels = (catalog: CatalogRow[]): Model<
      "openai-completions" | "openai-responses"
    >[] => providerModels(catalog, provider).map((model) => ({
      ...model,
      provider,
      baseUrl: baseUrlFromEnv(),
      api: model.api ?? "openai-completions",
    })) as Model<"openai-completions" | "openai-responses">[];
    const completions = admission ? {
      ...COMPLETIONS_API,
      streamSimple: (model, context, options) => admission.admissionStream(model, context, options, {
        enabled: () => !!admissionContext && SettingsManager.create(admissionContext.cwd, undefined, {
          projectTrusted: admissionContext.isProjectTrusted(),
        }).getRetrySettings().enabled,
        notify: (message) => admissionContext?.ui.notify(message, "info"),
      }),
    } satisfies ProviderStreams : COMPLETIONS_API;
    api.registerProvider(createProvider<"openai-completions" | "openai-responses">({
      id: provider,
      name: provider === "mantice" ? "Mantice" : "Fornace",
      baseUrl: baseUrlFromEnv(),
      auth: {
        apiKey: envApiKeyAuth(
          `${provider === "mantice" ? "Mantice" : "Fornace"} API key`,
          [provider === "mantice" ? "MANTICE_API_KEY" : "FORNACE_LLM_API_KEY"],
        ),
      },
      models: runtimeModels(rows),
      fetchModels: async () => runtimeModels(await resolveCatalog()),
      api: {
        "openai-completions": completions,
        "openai-responses": RESPONSES_API,
      },
    }));
  }

  const fast = registerFastCommands(api, {
    resetRtk: rtk.reset,
  });
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

  api.registerCommand("mantice-setup", {
    description: "Preview Mantice class-routing onboarding for your own gateway",
    handler: async (args, ctx) => {
      const config = args?.trim() || "setup.json";
      ctx.ui.notify(`Setup runs as a CLI so secrets and the APPLY gate stay in your shell: node ${"tools/setup.mjs"} --config ${config}`, "info");
      ctx.ui.notify("It refuses Fornace production gateways without --allow-prod + PROCEED.", "info");
    },
  });

  api.on("session_before_compact", async (event, ctx) => {
    // Mechanical pruning first. Pi's native ai-assisted compaction will
    // then receive the stripped payload and remains fast.
    const history = ctx.sessionManager.getBranch().flatMap(sessionEntryToContextMessages);
    const { messages, prunedMessages } = pruneSummaryToolResults(event.preparation.messagesToSummarize, history);
    
    if (prunedMessages > 0) {
      event.preparation.messagesToSummarize.length = 0;
      event.preparation.messagesToSummarize.push(...messages as any);
      
      // Inject pruning context string so the native ai-assisted model knows
      // how to recover what was pruned if needed.
      if (!event.customInstructions?.includes(PRUNING_CONTEXT)) {
        event.customInstructions = event.customInstructions
          ? `${event.customInstructions}\n\n${PRUNING_CONTEXT}`
          : PRUNING_CONTEXT;
      }
    }
    return undefined;
  });
}
