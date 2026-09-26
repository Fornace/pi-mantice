import type { Message, ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The only request change left from the retired spend guard. One unbounded tool
// result (a 929,590-token header read) overflows every context window, and
// compaction cannot help because it keeps the newest tool batch whole. Cap each
// oversized tool result in the REQUEST only: the session keeps the original,
// call pairing is untouched, and a request with nothing to cap goes out as is.
export const OVERSIZE_TOOL_RESULT_CHARS = 160_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 2_000;

const count = (value: number): string => value.toLocaleString("en-US");

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export function capToolResult(message: Message): Message {
  if (message.role !== "toolResult") return message;
  const text = toolResultText((message as { content?: unknown }).content);
  if (text.length < OVERSIZE_TOOL_RESULT_CHARS) return message;
  const at = new Date(message.timestamp).toLocaleTimeString(undefined, { hour12: false });
  const note = `[mantice: the ${at} ${message.toolName} result was ${count(text.length)} chars;`
    + ` kept the first ${count(HEAD_CHARS)} and last ${count(TAIL_CHARS)}.`
    + " Re-run it with a narrower offset/limit window for the rest.]\n";
  return {
    ...message,
    content: [{ type: "text", text: note + text.slice(0, HEAD_CHARS)
      + `\n[... ${count(text.length - HEAD_CHARS - TAIL_CHARS)} chars elided ...]\n` + text.slice(-TAIL_CHARS) }],
  } as Message;
}

export function capToolResults<T extends { messages: Message[] }>(context: T): T {
  let changed = false;
  const messages = context.messages.map((message) => {
    const capped = capToolResult(message);
    if (capped !== message) changed = true;
    return capped;
  });
  return changed ? { ...context, messages } : context;
}

export function limitToolResults(streams: ProviderStreams): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options) => streams.stream(model, capToolResults(context), options),
    streamSimple: (model, context, options) => streams.streamSimple(model, capToolResults(context), options),
  };
}

// Earlier releases persisted a spend-guard state that pi-codex-goal,
// pi-subagent-extension and pi-message-sidebar still read: a stale "paused" or
// "compacting" record would block goals, child dispatch and summaries forever.
// Close any such record once, and keep the two command names the subagent
// preflight requires of every child.
export const GUARD_ENTRY = "mantice-spend-guard";
export const GUARD_EVENT = "mantice:spend-guard";
const RETIRED = "spend guard retired in pi-mantice 1.6.0; requests are never reduced or paused";

export function registerGuardRetirement(api: ExtensionAPI) {
  const close = (ctx: ExtensionContext) => {
    const last = ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === GUARD_ENTRY).at(-1);
    const state = (last as { data?: { state?: string } } | undefined)?.data?.state;
    if (!last || state === "ready") return;
    const record = { version: 1, state: "ready", reason: RETIRED, at: Date.now() };
    api.appendEntry(GUARD_ENTRY, record);
    api.events.emit(GUARD_EVENT, { ...record, sessionId: ctx.sessionManager.getSessionId() });
  };
  api.on("session_start", (_event, ctx) => close(ctx));
  api.on("session_tree", (_event, ctx) => close(ctx));
  for (const name of ["mantice-guard", "mantice-child-budget"]) {
    api.registerCommand(name, {
      description: "Retired: requests are never reduced or paused",
      handler: async (_args, ctx) => ctx.ui.notify(RETIRED, "info"),
    });
  }
}
