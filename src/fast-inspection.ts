import { sessionEntryToContextMessages, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, createSummaryCheckpointStore } from "./summary-checkpoint.ts";
import { pruneSummaryToolResults, PRUNING_CONTEXT } from "./summary-pruning.ts";
import { serializeSummaryHistory } from "./summary-serialization.ts";
import { SUMMARY_CHUNK_BYTES } from "./summary-chunks.ts";

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
  const pruned = pruneSummaryToolResults(messages, branch.flatMap(sessionEntryToContextMessages));
  const before = priorBytes + Buffer.byteLength(serializeSummaryHistory(messages), "utf8");
  const after = priorBytes + Buffer.byteLength(serializeSummaryHistory(pruned.messages), "utf8")
    + (pruned.prunedMessages ? Buffer.byteLength(PRUNING_CONTEXT, "utf8") : 0);
  const savings = before ? ((1 - after / before) * 100).toFixed(1) : "0.0";
  return [
    `Pruning preview: ${size(before)} → ${size(after)} (${savings}% smaller).`,
    `${pruned.prunedMessages} older messages pruned; all user messages and last two rounds retained.`,
    `Estimated chunks: ${Math.ceil(before / SUMMARY_CHUNK_BYTES)} → ${Math.ceil(after / SUMMARY_CHUNK_BYTES)}.`,
    "Active-context byte estimate; Pi's retained window determines the actual compaction span. No model call made.",
  ].join("\n");
}

export function fastStatus(ctx: ExtensionCommandContext, running: boolean, modelIds: string[]): string {
  const branch = ctx.sessionManager.getBranch();
  const usage = ctx.getContextUsage();
  const lines = [
    `Session ${ctx.sessionManager.getSessionId().slice(-8)} · ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"}`,
    `Context: ${usage?.percent == null ? "unknown" : `${usage.percent.toFixed(1)}%`} · ${running ? "fast compaction running" : ctx.isIdle() ? "idle" : "working"}`,
    `Summarizers: ${modelIds.join(" → ") || "unavailable"}`,
    "Pruning: aggressive · all user messages + last two rounds kept",
  ];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction") { lines.push(`Last compaction: ${entry.timestamp}`); break; }
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE) continue;
    const data = entry.data as { key?: unknown; totalParts?: unknown } | undefined;
    if (typeof data?.key !== "string" || typeof data.totalParts !== "number") continue;
    const saved = createSummaryCheckpointStore(branch, () => {}).load(data.key, data.totalParts);
    if (saved) {
      lines.push(`Saved progress: ${saved.nextPart}/${saved.totalParts} parts; reuse requires unchanged input.`);
      break;
    }
  }
  return lines.join("\n");
}
