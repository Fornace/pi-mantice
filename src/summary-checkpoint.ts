import { createHash } from "node:crypto";
import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SUMMARY_CARRY_BYTES, SUMMARY_CHUNK_BYTES } from "./summary-chunks.ts";

export const CHECKPOINT_TYPE = "mantice-compaction-progress-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export interface SummaryCheckpoint {
  key: string;
  nextPart: number;
  totalParts: number;
  summary: string;
  usage?: CompactionResult["usage"];
  at: number;
}
export interface SummaryCheckpointStore {
  load(key: string, totalParts: number): SummaryCheckpoint | undefined;
  save(value: SummaryCheckpoint): void;
}

export function summaryCheckpointKey(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify([
    CHECKPOINT_TYPE, SUMMARY_CHUNK_BYTES, ...values,
  ])).digest("hex");
}

function validUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(k => finite(usage[k]))) return false;
  if (!["reasoning", "cacheWrite1h"].every(k => usage[k] === undefined || finite(usage[k]))) return false;
  const cost = usage.cost as Record<string, unknown> | undefined;
  return !!cost && ["input", "output", "cacheRead", "cacheWrite", "total"].every(k => finite(cost[k]));
}

// Read only the active branch, and never reuse progress preceding a committed
// compaction. Custom entries persist without entering model context.
export function createSummaryCheckpointStore(
  entries: SessionEntry[],
  append: (type: string, data: SummaryCheckpoint) => void,
): SummaryCheckpointStore {
  return {
    load(key, totalParts) {
      const now = Date.now();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "compaction") break;
        if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE) continue;
        const value = entry.data as Partial<SummaryCheckpoint> | undefined;
        if (!value || value.key !== key || value.totalParts !== totalParts) continue;
        if (!Number.isInteger(value.nextPart) || value.nextPart! < 1 || value.nextPart! > totalParts
          || typeof value.at !== "number" || !Number.isFinite(value.at) || value.at > now
          || now - value.at > MAX_AGE_MS || typeof value.summary !== "string"
          || !value.summary.trim() || Buffer.byteLength(value.summary, "utf8") > SUMMARY_CARRY_BYTES
          || !validUsage(value.usage)) continue;
        return value as SummaryCheckpoint;
      }
      return undefined;
    },
    save(value) { append(CHECKPOINT_TYPE, value); },
  };
}
