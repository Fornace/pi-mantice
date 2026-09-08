// Stage-one mechanical compaction: replace the summarized span with a bounded
// deterministic digest. Zero model calls, zero subprocesses, millisecond scale.
// Original session entries stay in the JSONL; only the summarizer's copy is
// transformed. Stage two (AI summary) stays Pi native: `session_before_compact`
// receives the pruned payload instead when this digest is not requested.

import { SUMMARY_PRUNING_VERSION } from "./summary-pruning.ts";

export const MECHANICAL_DIGEST_VERSION = "mechanical-v1";
/** Hard ceiling for the whole digest; keeps post-compaction context small. */
export const DIGEST_BUDGET_BYTES = 64_000;
/** Progressive per-message caps for older user text (head+tail bytes). */
const USER_CAP_STEPS = [16_384, 4_096, 1_024, 256, 128];
const ASSISTANT_TEXT_BYTES = 512;
const PREVIOUS_SUMMARY_BYTES = 24_000;
const TOOL_INDEX_LINE_BYTES = 400;
const FILE_LIST_MAX = 200;

/** File-operation sets from Pi's preparation, as sorted digest lists. */
export function fileListsOf(fileOps: {
  read: Set<string>; written: Set<string>; edited: Set<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter(file => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export interface MechanicalDigestInput {
  /** Pruned messagesToSummarize (output of pruneSummaryToolResults). */
  messages: unknown[];
  /** Pruned split-turn prefix, when Pi cut inside one huge turn. */
  turnPrefixMessages?: unknown[];
  previousSummary?: string;
  focus?: string;
  readFiles: string[];
  modifiedFiles: string[];
}

export interface MechanicalDigest {
  summary: string;
  bytes: number;
  userMessages: number;
  removedMessages: number;
  toolCalls: number;
  cappedUserBytes: number;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}

function excerpt(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let headEnd = Math.floor(limit * 2 / 3);
  let tailStart = bytes.length - Math.floor(limit / 3);
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
  return `${bytes.subarray(0, headEnd).toString("utf8")}\n[… stripped ${bytes.length - limit} bytes; original in session history …]\n${bytes.subarray(tailStart).toString("utf8")}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => block?.type === "text" && typeof block.text === "string"
    ? block.text : "").filter(Boolean).join("\n");
}

interface Classified {
  user: string[];
  assistant: string[];
  toolCalls: { name: string; path?: string }[];
  counts: { user: number; assistant: number; toolResult: number; other: number };
}

function classify(messages: unknown[]): Classified {
  const out: Classified = { user: [], assistant: [], toolCalls: [], counts: { user: 0, assistant: 0, toolResult: 0, other: 0 } };
  const seenAssistant = new Set<string>();
  for (const message of messages) {
    const value = record(message);
    if (!value) { out.counts.other++; continue; }
    if (value.role === "user") {
      const text = textOf(value.content).trim();
      if (text) { out.user.push(text); out.counts.user++; }
      continue;
    }
    if (value.role === "toolResult") { out.counts.toolResult++; continue; }
    if (value.role === "assistant" && Array.isArray(value.content)) {
      out.counts.assistant++;
      const text = textOf(value.content).trim();
      if (text && !seenAssistant.has(text)) { out.assistant.push(excerpt(text, ASSISTANT_TEXT_BYTES)); seenAssistant.add(text); }
      for (const block of value.content) {
        if (block?.type !== "toolCall") continue;
        const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
        out.toolCalls.push({ name: String(block.name ?? "tool"), path });
      }
      continue;
    }
    out.counts.other++;
  }
  return out;
}

function toolCallLine(call: { name: string; path?: string }): string {
  return call.path
    ? `${call.name} ${excerpt(call.path, 200)}`
    : excerpt(call.name, TOOL_INDEX_LINE_BYTES);
}

function fileList(title: string, files: string[]): string {
  if (!files.length) return "";
  const shown = files.slice(0, FILE_LIST_MAX).map(file => excerpt(file, 200));
  const more = files.length > FILE_LIST_MAX ? `\n[… ${files.length - FILE_LIST_MAX} more …]` : "";
  return `<${title}>\n${shown.join("\n")}${more}\n</${title}>`;
}

function renderUserSection(user: string[], perMessageBytes: number): string {
  return user.map(text => `User: ${excerpt(text, perMessageBytes)}`).join("\n\n");
}

const EXCERPT_MARKER_RESERVE = 128;

function addWithinBudget(parts: string[], section: string, budget: number): void {
  if (!section) return;
  const current = Buffer.byteLength(parts.join("\n\n"), "utf8");
  const separator = parts.length ? 2 : 0;
  const remaining = budget - current - separator - EXCERPT_MARKER_RESERVE;
  if (remaining <= 0) return;
  parts.push(excerpt(section, remaining));
}

function buildDigest(input: MechanicalDigestInput, perMessageBytes: number, budget: number): string {
  const span = [...(input.turnPrefixMessages ?? []), ...input.messages];
  const classified = classify(span);
  const head = `Mechanical context digest (${MECHANICAL_DIGEST_VERSION}, pruning ${SUMMARY_PRUNING_VERSION}). ` +
    `Span: ${span.length} messages (${classified.counts.user} user, ${classified.counts.assistant} assistant, ` +
    `${classified.counts.toolResult} tool results, ${classified.toolCalls.length} tool calls) replaced without an AI call. ` +
    `User messages are chronological excerpts; other historical content is mechanically stripped.`;
  const recovery = `Recovery: stripped content remains in original session history. Recover by file path or tool-call ID. ` +
    `Rerun only safe read-only checks. Never replay mutations or paid jobs. Use fast_read for cheap file re-reads.`;
  const parts = [head];
  addWithinBudget(parts, input.focus ? `## Focus\n${excerpt(input.focus, 4_000)}` : "", budget);
  addWithinBudget(parts, input.previousSummary
    ? `<previous-summary>\n${excerpt(input.previousSummary, PREVIOUS_SUMMARY_BYTES)}\n</previous-summary>` : "", budget);
  addWithinBudget(parts, `## User messages (chronological)\n${renderUserSection(classified.user, perMessageBytes)}`, budget);
  addWithinBudget(parts, classified.toolCalls.length
    ? `## Tool-call index\n${classified.toolCalls.map(toolCallLine).join(" · ")}` : "", budget);
  addWithinBudget(parts, fileList("read-files", input.readFiles), budget);
  addWithinBudget(parts, fileList("modified-files", input.modifiedFiles), budget);
  addWithinBudget(parts, classified.assistant.length
    ? `## Assistant text (deduplicated excerpts)\n${classified.assistant.join("\n\n")}` : "", budget);
  addWithinBudget(parts, recovery, budget);
  return parts.join("\n\n");
}

export function buildMechanicalDigest(input: MechanicalDigestInput, budget = DIGEST_BUDGET_BYTES): MechanicalDigest {
  const normalized: MechanicalDigestInput = {
    ...input,
    readFiles: input.readFiles ?? [],
    modifiedFiles: input.modifiedFiles ?? [],
  };
  const span = [...(normalized.turnPrefixMessages ?? []), ...normalized.messages];
  let summary = "";
  let cappedUserBytes = USER_CAP_STEPS.at(-1)!;
  for (const cap of USER_CAP_STEPS) {
    // Unclamped candidate: every section must fit on its own merits so each
    // user message keeps its share instead of the whole section being cut.
    const candidate = buildDigest(normalized, cap, Number.POSITIVE_INFINITY);
    if (Buffer.byteLength(candidate, "utf8") <= budget) {
      summary = candidate;
      cappedUserBytes = cap;
      break;
    }
  }
  if (!summary) {
    // No cap distributes the user text fairly within budget: fall back to a
    // clamped build that keeps the budget as a hard ceiling.
    summary = buildDigest(normalized, cappedUserBytes, budget);
  }
  const classified = classify(span);
  return {
    summary,
    bytes: Buffer.byteLength(summary, "utf8"),
    userMessages: classified.counts.user,
    removedMessages: span.length,
    toolCalls: classified.toolCalls.length,
    cappedUserBytes,
  };
}
