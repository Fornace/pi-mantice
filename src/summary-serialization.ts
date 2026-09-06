import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// Pi's default serializer clips every tool result, including the protected
// recent rounds. Pruning already bounded older output; retain recent text here.
export function serializeSummaryHistory(messages: unknown[]): string {
  return convertToLlm(messages as never).map(message => {
    if (message.role !== "toolResult") return serializeConversation([message]);
    const text = message.content.map(block => block.type === "text" ? block.text
      : "[Tool image retained in original session history]").join("\n");
    return text ? `[Tool result]: ${text}` : "";
  }).filter(Boolean).join("\n\n");
}
