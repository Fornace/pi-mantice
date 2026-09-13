import type { Context, Model, Api, ProviderStreams, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { childAllowance } from "./child-allowance.ts";
import { applyCheckpoint, compactRequest, estimate, type GuardCheckpoint } from "./guard-projection.ts";

export const GUARD_ENTRY = "mantice-spend-guard";
export const GUARD_EVENT = "mantice:spend-guard";
export const GUARD_LIMITS = {
  contextFraction: 0.5, contextTokens: 200_000,
  cumulativeTokens: 8_000_000, rateTokens: 2_000_000, rateWindowMs: 300_000,
  spendContextFloor: 32_000,
};
interface GuardState {
  version: 1;
  state: "ready" | "compacting" | "paused";
  reason: string;
  outcome?: "budget_yield";
  at: number;
  checkpoint?: GuardCheckpoint;
  before?: number;
  after?: number;
}
const initial = (): GuardState => ({ version: 1, state: "ready", reason: "startup", at: 0 });

export function registerSpendGuard(api: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let state = initial();
  let nativeMechanical = false;
  let summarizing = false;
  let retryRequested = false;

  function publish(next: GuardState) {
    state = next; // Close in memory before any persistence or observer can fail.
    api.appendEntry(GUARD_ENTRY, next);
    api.events.emit(GUARD_EVENT, { ...next, checkpoint: undefined,
      sessionId: ctx?.sessionManager.getSessionId() });
    if (next.state !== "ready") console.error(`[pi-mantice] guard ${next.state}: ${next.reason}`);
  }
  function recoveryInstruction(reason: string, outcome?: GuardState["outcome"]) {
    return outcome === "budget_yield"
      ? "Worker yielded its resumable session to the parent."
      : reason.startsWith("managed child hard allowance")
      ? "Human recovery requires /mantice-child-budget <total> in an idle interactive session."
      : "Repair then /mantice-guard retry.";
  }
  function pause(reason: string, outcome?: GuardState["outcome"]): never {
    publish({ ...state, state: "paused", reason, at: Date.now(), ...(outcome ? { outcome } : {}) });
    // Avoid overflow/retry keywords: this error is terminal, never AI recovery.
    throw new Error(`Mantice spend guard paused: ${reason}. ${recoveryInstruction(reason, outcome)}`);
  }
  const allowance = childAllowance(api, () => ctx, pause);
  function restore(context: ExtensionContext) {
    ctx = context;
    state = initial();
    retryRequested = false;
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === GUARD_ENTRY) {
        const value = entry.data as GuardState;
        if (value?.version !== 1 || !["ready", "compacting", "paused"].includes(value.state) ||
          (value.outcome !== undefined && value.outcome !== "budget_yield")) {
          pause("invalid durable guard record");
        }
        state = value;
      }
    }
    if (state.state === "compacting") publish({ ...state, state: "paused", reason: "interrupted mechanical compaction" });
  }
  api.on("session_start", (_event, context) => restore(context));
  api.on("session_tree", (_event, context) => restore(context));
  api.on("session_shutdown", () => { ctx = undefined; });
  api.on("session_before_compact", (event, context) => {
    if (!["mantice", "fornace"].includes(context.model?.provider ?? "")) return;
    summarizing = true;
    nativeMechanical = event.reason !== "manual" || state.state !== "ready";
  });
  api.on("session_compact", () => {
    // Native compaction changes the input prefix. Clear only the projection;
    // a paused guard still requires a verified reduction before request admission.
    publish({ ...state, checkpoint: undefined });
    nativeMechanical = false;
    summarizing = false;
  });
  api.on("session_compact_failed", () => {
    if (nativeMechanical) publish({ ...state, state: "paused", reason: "native mechanical compaction failed", at: Date.now() });
    nativeMechanical = false;
    summarizing = false;
  });
  api.registerCommand("mantice-guard", {
    description: "Show spend guard state or retry mechanical reduction after repair",
    handler: async (args, context) => {
      if (args.trim() === "retry") {
        if (allowance.snapshot()?.blocked) throw new Error("Managed child hard allowance requires human recovery");
        retryRequested = true;
        context.ui.notify("Mechanical retry armed for the next request. The pause clears only after reduction.", "info");
      } else if (args.trim() && args.trim() !== "status") {
        throw new Error("Use /mantice-guard status or /mantice-guard retry");
      } else context.ui.notify(JSON.stringify({ ...state, checkpoint: undefined, limits: GUARD_LIMITS,
        allowance: allowance.snapshot() }), "info");
    },
  });

  api.registerCommand("mantice-child-budget", {
    description: "Inspect child lifetime allowance or explicitly raise its total in a human session",
    handler: async (args, context) => {
      const value = args.trim();
      if (value && value !== "status") {
        allowance.grant(value, context);
        if (state.reason.startsWith("managed child hard allowance")) {
          publish({ ...state, state: "ready", reason: "human raised child total allowance", at: Date.now() });
        }
      }
      context.ui.notify(JSON.stringify(allowance.snapshot() ?? { managedChild: false }), "info");
    },
  });

  function prepare(model: Model<Api>, context: Context): Context {
    if (!ctx) throw new Error("Mantice spend guard has no session context");
    const childState = allowance.snapshot();
    if (childState?.blocked) pause("managed child hard allowance paused", childState.outcome);
    if (nativeMechanical) pause("automatic summarizer attempted a model call");
    if (summarizing && state.state === "ready") {
      if (estimate(context) >= Math.min(GUARD_LIMITS.contextTokens, model.contextWindow * 0.5)) {
        pause("manual summary requires mechanical reduction first");
      }
      return context;
    }
    if (state.state !== "ready" && !retryRequested) {
      throw new Error(`Mantice spend guard paused: ${state.reason}. ${recoveryInstruction(state.reason, state.outcome)}`);
    }
    const forced = retryRequested;
    retryRequested = false;
    let projected: Context;
    try { projected = { ...context, messages: applyCheckpoint(context.messages, state.checkpoint) }; }
    catch (error) {
      if (!forced) pause(error instanceof Error ? error.message : "checkpoint validation failed");
      // Explicit repair retry rebuilds from complete original request history.
      state = { ...state, checkpoint: undefined };
      projected = context;
    }
    const now = Date.now();
    let cumulative = 0, recent = 0;
    let lastUsage = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message;
      if (message.timestamp <= (state.checkpoint?.at ?? 0)) continue;
      const usage = message.usage;
      const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      cumulative += tokens;
      if (message.timestamp >= now - GUARD_LIMITS.rateWindowMs) recent += tokens;
      lastUsage = usage.input + usage.cacheRead + usage.cacheWrite;
    }
    const estimated = estimate(projected);
    const before = Math.max(estimated, lastUsage);
    const limit = Math.min(GUARD_LIMITS.contextTokens, model.contextWindow * GUARD_LIMITS.contextFraction);
    const reason = forced ? "repair retry"
      : before >= limit ? "context soft threshold"
      : before >= GUARD_LIMITS.spendContextFloor && cumulative >= GUARD_LIMITS.cumulativeTokens ? "cumulative token soft threshold"
      : before >= GUARD_LIMITS.spendContextFloor && recent >= GUARD_LIMITS.rateTokens ? "token rate soft threshold"
      : undefined;
    if (!reason) return projected;
    publish({ ...state, state: "compacting", reason, before, at: now });
    try {
      const reduced = compactRequest(context, state.checkpoint);
      const after = estimate(reduced.context);
      if (after >= limit || after > estimated * 0.9) {
        pause("mechanical reduction made insufficient progress");
      }
      publish({ version: 1, state: "ready", reason: "mechanical reduction verified", at: Date.now(),
        checkpoint: reduced.checkpoint, before, after });
      return reduced.context;
    } catch (error) {
      if (state.state === "paused") throw error;
      pause(error instanceof Error ? error.message : "mechanical reduction failed");
    }
  }

  function wrap(streams: ProviderStreams): ProviderStreams {
    return {
      ...streams,
      stream: (model, context, options) => lazyStream(model, async () => {
        const projected = prepare(model, context);
        const reservation = allowance.reserve(model, options);
        return account(streams.stream(model, projected, options), reservation);
      }),
      streamSimple: (model, context, options) => lazyStream(model, async () => {
        const projected = prepare(model, context);
        const reservation = allowance.reserve(model, options);
        return account(streams.streamSimple(model, projected, options), reservation);
      }),
    };
  }
  async function* account(stream: AsyncIterable<AssistantMessageEvent>, reservation?: string) {
    for await (const event of stream) {
      if (event.type === "done") allowance.settle(reservation, event.message);
      if (event.type === "error") allowance.settle(reservation, event.error);
      yield event;
    }
  }
  return { wrap, needsMechanical: () => nativeMechanical || state.state !== "ready" };
}
