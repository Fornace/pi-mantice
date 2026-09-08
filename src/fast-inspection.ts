import { sessionEntryToContextMessages, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DIGEST_BUDGET_BYTES } from "./mechanical-compaction.ts";
import { pruneSummaryToolResults } from "./summary-pruning.ts";
import { serializeSummaryHistory } from "./summary-serialization.ts";

function size(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function fastPreview(ctx: ExtensionCommandContext): string {
  const branch = ctx.sessionManager.getBranch();
  const active = ctx.sessionManager.buildContextEntries();
  const messages = active.filter(entry => entry.type !== "compaction")
    .flatMap(sessionEntryToContextMessages);
  const previous = active.find(entry => entry.type === "compaction");
  const priorBytes = previous?.type === "compaction" ? Buffer.byteLength(previous.summary, "utf8") : 0;
  const history = branch.flatMap(sessionEntryToContextMessages);
  const pruned = pruneSummaryToolResults(messages, history);
  const before = priorBytes + Buffer.byteLength(serializeSummaryHistory(messages), "utf8");
  const after = priorBytes + Buffer.byteLength(serializeSummaryHistory(pruned.messages), "utf8");
  const savings = before ? ((1 - after / before) * 100).toFixed(1) : "0.0";
  return [
    `Pruning preview: ${size(before)} → ${size(after)} (${savings}% smaller).`,
    `${pruned.prunedMessages} older messages pruned mechanically; all user messages and last two rounds retained.`,
    `Mechanical digest (/fast session) replaces the summarized span with at most ${size(DIGEST_BUDGET_BYTES)} of retained user text, zero model calls.`,
    `Pi's keepRecentTokens window determines the exact compaction span. No model call made.`,
  ].join("\n");
}

export function fastStatus(ctx: ExtensionCommandContext, running: boolean): string {
  const branch = ctx.sessionManager.getBranch();
  const usage = ctx.getContextUsage();
  const lines = [
    `Session ${ctx.sessionManager.getSessionId().slice(-8)} · ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"}`,
    `Context: ${usage?.percent == null ? "unknown" : `${usage.percent.toFixed(1)}%`} · ${running ? "mechanical compaction running" : ctx.isIdle() ? "idle" : "working"}`,
    "Stage 1: mechanical pruning (RTK-style, zero model calls)",
    "Stage 2: /compact Pi native AI compaction on the pruned context",
    "Pruning: aggressive · all user messages + last two rounds kept",
  ];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction") { lines.push(`Last compaction: ${entry.timestamp}`); break; }
  }
  return lines.join("\n");
}
