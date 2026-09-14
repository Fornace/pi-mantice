import { createHash } from "node:crypto";
import type { Context, Message } from "@earendil-works/pi-ai";
import { buildMechanicalDigest } from "./mechanical-compaction.ts";

export interface GuardCheckpoint {
  count: number;
  prefixHash: string;
  summary: string;
  summaryHash: string;
  at: number;
}

export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Pi's own estimator counts each image as a fixed 4800 chars (1200 tokens):
// providers charge the decoded raster, not the base64 wire encoding, so
// serializing raw content multiplies every image by 4/3 of its byte size and
// pauses sessions on spend that never happens. A tool result's `details` is
// local render state that never enters a request. Reported provider usage is
// also considered by the guard. This is deliberately not a billing meter.
const ESTIMATED_IMAGE_CHARS = 4800;

function contentChars(content: string | readonly unknown[]): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content as { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }[]) {
    if (block?.type === "text" && block.text) chars += block.text.length;
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
    else if (block?.type === "thinking" && block.thinking) chars += block.thinking.length;
    else if (block?.type === "toolCall") chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
  }
  return chars;
}

export function estimateMessage(message: Message): number {
  return Math.ceil(contentChars((message as { content?: string | readonly unknown[] }).content ?? "") / 4);
}

export function estimate(context: Context): number {
  let chars = context.systemPrompt?.length ?? 0;
  for (const tool of context.tools ?? []) {
    chars += tool.name.length + tool.description.length + JSON.stringify(tool.parameters ?? {}).length;
  }
  for (const message of context.messages) {
    chars += contentChars((message as { content?: string | readonly unknown[] }).content ?? "");
  }
  return Math.ceil(chars / 4);
}

const count = (value: number): string => value.toLocaleString("en-US");

const describe = (message: Message): string => {
  const at = new Date(message.timestamp).toLocaleTimeString(undefined, { hour12: false });
  return message.role === "toolResult"
    ? `the ${at} ${message.toolName} tool result`
    : `the ${at} ${message.role} message`;
};

function heaviest(messages: Message[]): { label: string; tokens: number } | undefined {
  let top: { label: string; tokens: number } | undefined;
  for (const message of messages) {
    const tokens = estimate({ messages: [message] });
    if (!top || tokens > top.tokens) top = { label: describe(message), tokens };
  }
  return top;
}

// A stalled reduction has several distinct causes and each one has a different
// way out. Name the one that actually blocked this request: a pause the operator
// cannot act on is a dead end, not a brake.
export function explainStalledReduction(args: {
  reduced: Context; estimated: number; after: number; limit: number;
}): { reason: string; recovery: string } {
  const { reduced, estimated, after, limit } = args;
  const overhead = estimate({ ...reduced, messages: [] });
  const freed = Math.round((1 - after / estimated) * 100);
  const headline = after >= limit
    ? `mechanical reduction reached ${count(after)} tokens, still over the ${count(limit)} limit`
    : freed > 0
    ? `mechanical reduction freed only ${freed}% of ${count(estimated)} tokens`
    : `mechanical reduction did not shrink the request below ${count(after)} tokens`;
  const top = heaviest(reduced.messages);
  if (top && top.tokens >= after / 2) {
    return {
      reason: `${headline}; ${top.label} is ${count(top.tokens)} tokens of it`,
      recovery: "Rewind past that message with /tree, or start a fresh session with /new."
        + " /mantice-guard retry keeps it: reduction never drops the newest tool batch.",
    };
  }
  if (overhead >= after / 2) {
    return {
      reason: `${headline}; the system prompt and ${reduced.tools?.length ?? 0} tool schemas`
        + ` are ${count(overhead)} tokens of it, before any history`,
      recovery: "Load fewer tools or extensions, or start a fresh session with /new."
        + " Reduction cannot touch either, so /mantice-guard retry will stall here again.",
    };
  }
  return {
    reason: `${headline}; ${reduced.messages.length} retained messages hold`
      + ` ${count(Math.max(after - overhead, 0))} tokens with no single dominant one`,
    recovery: "Rewind to before the heavy turns with /tree, or start a fresh session with /new.",
  };
}

export function applyCheckpoint(messages: Message[], checkpoint?: GuardCheckpoint): Message[] {
  if (!checkpoint) return messages;
  if (!Number.isInteger(checkpoint.count) || checkpoint.count < 1
    || typeof checkpoint.summary !== "string" || hash(checkpoint.summary) !== checkpoint.summaryHash) {
    throw new Error("checkpoint integrity failure");
  }
  if (hash(messages.slice(0, checkpoint.count)) !== checkpoint.prefixHash) {
    throw new Error("checkpoint prefix changed; mechanical rebuild required");
  }
  return [{ role: "user", content: checkpoint.summary, timestamp: checkpoint.at },
    ...messages.slice(checkpoint.count)];
}

export function assertPairs(messages: Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("unpaired retained tool result");
    } else {
      if (pending.size) throw new Error("incomplete retained tool batch");
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") {
            if (pending.has(block.id)) throw new Error("duplicate retained tool call");
            pending.add(block.id);
          }
        }
      }
    }
  }
  if (pending.size) throw new Error("unfinished retained tool batch");
}

// Everything in the request belongs to the newest tool batch, which reduction
// must keep whole, so there is nothing older left to fold into a digest.
export const IRREDUCIBLE = "the request is already one indivisible tool batch";

export function compactRequest(context: Context, previous?: GuardCheckpoint): {
  context: Context; checkpoint: GuardCheckpoint;
} {
  const messages = applyCheckpoint(context.messages, previous);
  let cut = messages.length;
  let tokens = 0;
  // Keep at least the newest message and about 20K tokens. Walk back to a
  // complete batch boundary, never separate a call from any sibling result.
  while (cut > 0 && (tokens < 20_000 || cut === messages.length)) {
    tokens += estimate({ messages: [messages[--cut]] });
  }
  while (cut > 0 && messages[cut]?.role === "toolResult") cut--;
  if (cut === 0) throw new Error(IRREDUCIBLE);
  const tail = messages.slice(cut);
  assertPairs(tail);
  const prefix = messages.slice(0, cut);
  const digest = buildMechanicalDigest({
    messages: previous ? prefix.slice(1) : prefix,
    previousSummary: previous?.summary,
    readFiles: [], modifiedFiles: [],
  });
  const count = cut + (previous ? previous.count - 1 : 0);
  const checkpoint: GuardCheckpoint = {
    count, prefixHash: hash(context.messages.slice(0, count)),
    summary: digest.summary, summaryHash: hash(digest.summary), at: Date.now(),
  };
  return { context: { ...context, messages: applyCheckpoint(context.messages, checkpoint) }, checkpoint };
}
