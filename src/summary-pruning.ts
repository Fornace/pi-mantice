// Only the summarizer's working copy is pruned. Session entries, tool calls,
// recent retained context, errors, and user/assistant messages stay untouched.
export const SUMMARY_PRUNING_VERSION = "tool-results-v1";
export const TOOL_RESULT_KEEP_BYTES = 2048;
export const STRIPPED_TOOL_RESULT =
  "Tool result stripped for compaction; original retained in session history. " +
  "Recover from history or saved artifacts first. If needed, rerun only safe " +
  "read-only checks; use RKT if available. Do not repeat mutations or paid jobs.";

export function pruneSummaryToolResults(messages: unknown[]): {
  messages: unknown[];
  strippedResults: number;
} {
  let strippedResults = 0;
  const pruned = messages.map(message => {
    if (!message || typeof message !== "object") return message;
    const value = message as Record<string, unknown>;
    // Unknown or failed outcomes are not evidence of successful execution.
    if (value.role !== "toolResult" || value.isError !== false
      || !Array.isArray(value.content)) return message;
    let bytes = 0;
    for (const block of value.content) {
      if (!block || typeof block !== "object") return message;
      if (block.type === "text" && typeof block.text === "string") {
        bytes += Buffer.byteLength(block.text, "utf8");
      } else if (block.type === "image" && typeof block.data === "string") {
        bytes += Buffer.byteLength(block.data, "utf8");
      } else return message;
    }
    if (bytes <= TOOL_RESULT_KEEP_BYTES) return message;
    strippedResults++;
    // Do not leave a second copy of raw output in provider-specific details.
    const { details: _details, ...metadata } = value;
    const reference = JSON.stringify({ toolName: value.toolName, toolCallId: value.toolCallId });
    return { ...metadata, content: [{ type: "text", text: `${STRIPPED_TOOL_RESULT}\nHistory reference: ${reference}` }] };
  });
  return { messages: pruned, strippedResults };
}
