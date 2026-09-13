import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ALLOWANCE_ENTRY = "mantice-child-allowance";
export const CHILD_ALLOWANCE = 8_000_000;
type Record =
  | { kind: "open"; limit: number; baseline: number }
  | { kind: "reserve"; id: string; tokens: number }
  | { kind: "settle"; id: string; tokens: number }
  | { kind: "pause"; reason: string; outcome?: "budget_yield" }
  | { kind: "grant"; limit: number };
const tokensOf = (message: AssistantMessage) => {
  const { input, output, cacheRead, cacheWrite } = message.usage;
  const values = [input, output, cacheRead, cacheWrite];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid child usage");
  return values.reduce((sum, value) => sum + value, 0);
};

export function childAllowance(api: ExtensionAPI, getContext: () => ExtensionContext | undefined,
  pause: (reason: string, outcome?: "budget_yield") => never) {
  function snapshot() {
    const ctx = getContext();
    if (!ctx) throw new Error("Missing allowance session context");
    const entries = ctx.sessionManager.getEntries(); // All branches, including abandoned ones.
    const policyEntries = entries.filter(e => e.type === "custom" && e.customType === "subagent-lifetime-policy");
    let initialLimit = CHILD_ALLOWANCE;
    for (const entry of policyEntries) {
      const policy = (entry as { data: { version?: number; tokenLimit?: number } }).data;
      if (policy?.version !== 1 || !Number.isSafeInteger(policy.tokenLimit)
        || policy.tokenLimit! <= 0 || policy.tokenLimit! > 10_000_000) pause("invalid durable child lifetime policy");
      if (entry !== policyEntries[0] && policy.tokenLimit !== initialLimit) pause("conflicting child lifetime policies");
      initialLimit = policy.tokenLimit!;
    }
    const records = entries.filter(e => e.type === "custom" && e.customType === ALLOWANCE_ENTRY)
      .map(e => (e as { data: { version: number } & Record }).data);
    if (!records.length && !process.env.PI_SUBAGENT_OWNER_PID) return undefined;
    const file = ctx.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) pause("managed child requires a pre-created persistent session");
    if (!records.length) {
      const baseline = entries.reduce((sum, entry) => sum + (entry.type === "message"
        && entry.message.role === "assistant" ? tokensOf(entry.message) : 0), 0);
      const record = { version: 1, kind: "open" as const, limit: initialLimit, baseline };
      api.appendEntry(ALLOWANCE_ENTRY, record);
      records.push(record);
    }
    let limit = 0, spent = 0, blocked = false;
    let outcome: "budget_yield" | undefined;
    const reservations = new Map<string, number>();
    const settled = new Set<string>();
    for (const [index, record] of records.entries()) {
      if (record.version !== 1) pause("invalid child allowance version");
      switch (record.kind) {
        case "open":
          if (index !== 0 || !Number.isSafeInteger(record.baseline) || record.baseline < 0
            || record.limit !== initialLimit) pause("invalid child allowance origin");
          limit = record.limit; spent = record.baseline; break;
        case "reserve":
          if (!limit || reservations.has(record.id) || !Number.isSafeInteger(record.tokens) || record.tokens <= 0) {
            pause("invalid child reservation");
          }
          reservations.set(record.id, record.tokens); break;
        case "settle":
          if (!reservations.has(record.id) || settled.has(record.id)
            || !Number.isSafeInteger(record.tokens) || record.tokens < 0) pause("invalid child settlement");
          settled.add(record.id); reservations.set(record.id, record.tokens); break;
        case "pause":
          if (record.outcome !== undefined && record.outcome !== "budget_yield") pause("invalid child allowance outcome");
          blocked = true; outcome = record.outcome; break;
        case "grant":
          if (!Number.isSafeInteger(record.limit) || record.limit <= limit) pause("invalid child allowance grant");
          limit = record.limit; blocked = false; outcome = undefined; break;
        default: pause("invalid child allowance record");
      }
    }
    return { limit, spent: spent + [...reservations.values()].reduce((sum, value) => sum + value, 0), blocked, outcome };
  }
  function block(reason: string, outcome?: "budget_yield"): never {
    api.appendEntry(ALLOWANCE_ENTRY, { version: 1, kind: "pause", reason, ...(outcome ? { outcome } : {}) });
    pause(reason, outcome);
  }
  function reserve(model: Model<Api>, options?: SimpleStreamOptions): string | undefined {
    const state = snapshot();
    if (!state) return undefined;
    if (state.blocked) pause("managed child hard allowance paused; human allowance recovery required");
    // Worst-case request reservation, independent of byte/token heuristics.
    // Provider must honor its advertised input window and the output ceiling.
    const tokens = model.contextWindow + (options?.maxTokens ?? model.maxTokens);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) block("invalid managed child request ceiling");
    if (state.spent + tokens > state.limit) {
      block(`managed child hard allowance: ${state.spent} charged/reserved, ${tokens} required, ${state.limit} total`,
        "budget_yield");
    }
    const id = randomUUID();
    api.appendEntry(ALLOWANCE_ENTRY, { version: 1, kind: "reserve", id, tokens });
    return id;
  }
  function settle(id: string | undefined, message: AssistantMessage) {
    if (!id) return;
    const tokens = tokensOf(message);
    // A failed/aborted stream with zero usage has unknown upstream consumption.
    // Keep its reservation across restart instead of pretending it was free.
    if ((message.stopReason === "error" || message.stopReason === "aborted") && tokens === 0) return;
    api.appendEntry(ALLOWANCE_ENTRY, { version: 1, kind: "settle", id, tokens });
  }
  function grant(value: string, ctx: ExtensionContext) {
    // RPC has a UI bridge and reports hasUI=true. It is not human authority.
    if (ctx.mode !== "tui" || !ctx.isIdle() || !process.stdin.isTTY || !process.stdout.isTTY
      || process.env.PI_SUBAGENT_OWNER_PID) {
      throw new Error("Child allowance recovery requires an idle interactive human session");
    }
    const state = snapshot();
    const limit = Number(value);
    if (!state || !Number.isSafeInteger(limit) || limit <= Math.max(state.limit, state.spent)) {
      throw new Error("Specify a total allowance greater than the current allowance and charged tokens");
    }
    api.appendEntry(ALLOWANCE_ENTRY, { version: 1, kind: "grant", limit });
  }
  return { reserve, settle, grant, snapshot };
}
