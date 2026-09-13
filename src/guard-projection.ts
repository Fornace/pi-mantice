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

// Request estimate, including schemas/system and images. Reported provider usage
// is also considered by the guard. This is deliberately not a billing meter.
export function estimate(context: Context): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 4);
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
  if (cut === 0) throw new Error("no reducible history before retained tail");
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
