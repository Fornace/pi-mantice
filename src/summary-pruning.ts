// Prune only the summarizer's copy. Original session entries remain recoverable.
export const SUMMARY_PRUNING_VERSION = "aggressive-two-rounds-v2";
export const STRIPPED_TOOL_RESULT = "Tool result stripped for compaction";
export const PRUNING_CONTEXT = "Older non-user history is aggressively pruned. " +
  "Full user messages and the last two user-led rounds are retained. " +
  "Recover omitted content from original session history by tool-call ID or saved artifacts. " +
  "Rerun only safe read-only checks, using RTK if available; never replay mutations or paid jobs.";

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}

function excerpt(text: string, limit = 768): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let headEnd = Math.floor(limit * 2 / 3);
  let tailStart = bytes.length - Math.floor(limit / 3);
  while ((bytes[headEnd] & 0xc0) === 0x80) headEnd--;
  while ((bytes[tailStart] & 0xc0) === 0x80) tailStart++;
  return `${bytes.subarray(0, headEnd).toString("utf8")}\n[content stripped; original in session history]\n${bytes.subarray(tailStart).toString("utf8")}`;
}

export function pruneSummaryToolResults(messages: unknown[], history = messages): {
  messages: unknown[];
  strippedResults: number;
  prunedMessages: number;
} {
  // A round begins with a user message and includes its tools and responses.
  // Use the active branch when Pi keeps recent context outside this span.
  let rounds = 0;
  let boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (record(history[i])?.role === "user" && ++rounds === 2) { boundary = i; break; }
  }
  const recent = new Set(history.slice(boundary));
  const boundaryTime = record(history[boundary])?.timestamp;
  let strippedResults = 0;
  let prunedMessages = 0;
  const seenText = new Set<string>();
  const pruned: unknown[] = [];
  for (const message of messages) {
    const value = record(message);
    if (!value || value.role === "user" || recent.has(message)
      || (typeof boundaryTime === "number" && typeof value.timestamp === "number"
        && value.timestamp >= boundaryTime)) {
      pruned.push(message);
      continue;
    }
    prunedMessages++;
    const { details: _details, ...metadata } = value;
    if (value.role === "toolResult") {
      strippedResults++;
      pruned.push({ ...metadata, content: [{ type: "text", text:
        `${STRIPPED_TOOL_RESULT}; id=${value.toolCallId}; error=${value.isError}` }] });
    } else if (value.role === "assistant" && Array.isArray(value.content)) {
      const text = value.content.filter((b: any) => b?.type === "text")
        .map((b: any) => b.text).filter((t: unknown) => typeof t === "string").join("\n");
      const content: unknown[] = [];
      if (text && !seenText.has(text)) {
        content.push({ type: "text", text: excerpt(text) });
        seenText.add(text);
      }
      for (const block of value.content) {
        if (block?.type !== "toolCall") continue;
        const args: Record<string, unknown> = { historyToolCallId: block.id, stripped: true };
        if (typeof block.arguments?.path === "string") args.path = excerpt(block.arguments.path, 256);
        content.push({ ...block, arguments: args });
      }
      if (content.length) pruned.push({ ...metadata, content });
    } else {
      pruned.push({ ...metadata, content: [{ type: "text", text: "[Historical non-user content stripped]" }] });
    }
  }
  return { messages: pruned, strippedResults, prunedMessages };
}
