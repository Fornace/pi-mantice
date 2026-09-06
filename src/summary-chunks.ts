import type { CompactionResult } from "@earendil-works/pi-coding-agent";

// Bound serialized input, not just the session's provider-specific token estimate.
// Leave separate room for the carried summary, instructions and output tokens.
export const SUMMARY_CHUNK_BYTES = 256_000;
export const SUMMARY_CARRY_BYTES = 128_000;

export function splitSummaryInput(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + SUMMARY_CHUNK_BYTES, bytes.length);
    // UTF-8 continuation bytes must remain with their leading byte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts.length ? parts : [""];
}

export function addSummaryUsage(
  left: CompactionResult["usage"], right: CompactionResult["usage"],
): CompactionResult["usage"] {
  if (!left) return right;
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
      ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) } : {}),
    ...(left.reasoning !== undefined || right.reasoning !== undefined
      ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) } : {}),
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}
