// pi-mantice: Pi ⇄ Mantice gateway integration.
//
// Registers the mantice/fornace providers from the authenticated live
// /v1/models catalog (snapshot fallback, logged loudly), derives Pi model
// metadata from M0 capability fields (legacy literal tier for older
// gateways), splits compaction into a mechanical stage (/fast session) and
// Pi-native AI compaction on pruned input, canonicalizes context overflow
// errors so Pi's auto-compaction recovers, and reports which backend model
// actually served each route.

import { readFile } from "node:fs/promises";
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
import { buildMechanicalDigest, fileListsOf, MECHANICAL_DIGEST_VERSION } from "../src/mechanical-compaction.ts";
import { createMechanicalGate, registerFastCommands, type CompactionStats } from "../src/fast-commands.ts";
import { registerRtk } from "../src/rtk.ts";
import { registerRtkTools } from "../src/rtk-tools.ts";
import { registerSessionIdentity } from "../src/session-identity.ts";
import { pruneSummaryToolResults } from "../src/summary-pruning.ts";
import { supportsCompactionRecovery } from "../src/admission-recovery.ts";

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
  await registerRtkTools(api);
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
      }, COMPLETIONS_API.streamSimple),
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

  const mechanicalGate = createMechanicalGate();
  const compactionStats: CompactionStats = {};
  const fast = registerFastCommands(api, {
    resetRtk: rtk.reset,
    gate: mechanicalGate,
    stats: compactionStats,
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
    // Stage 1, always: aggressive mechanical pruning of the summarizer's copy.
    // Original session entries are untouched and remain recoverable.
    const history = ctx.sessionManager.getBranch().flatMap(sessionEntryToContextMessages);
    const preparation = event.preparation;
    const pruned = pruneSummaryToolResults(preparation.messagesToSummarize, history);
    const prunedPrefix = pruneSummaryToolResults(preparation.turnPrefixMessages ?? [], history);

    // /fast session: replace the span with the mechanical digest directly.
    // Zero model calls; the digest is deterministic and byte-bounded.
    if (mechanicalGate.consume(ctx.sessionManager.getSessionId())) {
      const fileLists = fileListsOf(preparation.fileOps);
      const digest = buildMechanicalDigest({
        messages: pruned.messages,
        turnPrefixMessages: prunedPrefix.messages,
        previousSummary: preparation.previousSummary,
        focus: event.customInstructions,
        readFiles: fileLists.readFiles,
        modifiedFiles: fileLists.modifiedFiles,
      });
      compactionStats.tokensBefore = preparation.tokensBefore;
      compactionStats.digestBytes = digest.bytes;
      compactionStats.removedMessages = digest.removedMessages;
      compactionStats.prunedMessages = pruned.prunedMessages;
      return {
        compaction: {
          summary: digest.summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            mechanical: true,
            version: MECHANICAL_DIGEST_VERSION,
            removedMessages: digest.removedMessages,
            digestBytes: digest.bytes,
            userMessages: digest.userMessages,
          },
        },
      };
    }

    // Stage 2 stays Pi native: hand Pi's AI summarizer the pruned payload.
    // Note: Pi 0.85.1 does not read back event.customInstructions mutations, so
    // the pruned messages carry their own recovery markers instead.
    for (const [target, source] of [
      [preparation.messagesToSummarize, pruned.messages],
      [preparation.turnPrefixMessages, prunedPrefix.messages],
    ] as [any[], unknown[]]) {
      if (!source.length) continue;
      target.length = 0;
      target.push(...source);
    }
    return undefined;
  });
}
