// Flash-class compaction for Mantice sessions. The handler summarizes with
// the cheapest text class the gateway advertises (fornace-flash, then
// fornace-fast), records usage, and only then falls back or cancels per the
// trigger reason. It never silently compacts with the session's max-class
// model.

import type {
  CompactionResult,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { TextClass } from "./classes.ts";
import { gatewaySessionIdentity, SESSION_HEADER } from "./session-identity.ts";

export type CompactEvent = Pick<SessionBeforeCompactEvent, "preparation" | "reason" | "signal" | "customInstructions">;

export interface CompactionDeps {
  chain: TextClass[];
  modelIds: string[];
  resolveModel: (id: string) => unknown | null;
  complete: (
    model: unknown,
    context: { messages: unknown[] },
    options: { maxTokens: number; signal: AbortSignal; cacheRetention: string; sessionId: string; headers?: Record<string, string> },
  ) => Promise<{ text: string; usage?: CompactionResult["usage"] }>;
  newSessionId: () => string;
  conversationId?: string;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}

export const SUMMARY_MAX_TOKENS = 8192;

const SUMMARY_FORMAT = `## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions
## Next Steps
## Critical Context`;

export function summaryPrompt(
  conversationText: string,
  previousSummary?: string | null,
  customInstructions?: string,
): string {
  const prior = previousSummary
    ? `\n\nPrevious session summary to carry forward:\n${previousSummary}`
    : "";
  return `Summarize this coding-agent conversation for context replacement.${prior}
Keep every fact needed to continue the work: goals, constraints, decisions and
rationale, file paths changed, current state, blockers, and next steps. Answer
in this exact section format:\n${SUMMARY_FORMAT}

<conversation>
${conversationText}
</conversation>${customInstructions?.trim()
    ? `\n\nAdditional instructions for this compaction:\n${customInstructions}`
    : ""}`;
}

export async function compactWithClassChain(
  event: CompactEvent,
  deps: CompactionDeps,
  serialize: (messages: unknown[]) => string,
): Promise<
  { compaction: CompactionResult } | { cancel: true } | undefined
> {
  const { preparation, reason, signal } = event;
  if (signal.aborted) return { cancel: true };
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  if (!messages.length || !deps.modelIds.length) return undefined;
  const conversationText = serialize(messages as never[]);
  const prompt = summaryPrompt(conversationText, preparation.previousSummary, event.customInstructions);
  const summaryMessages = [{
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  }];
  const identity = gatewaySessionIdentity(deps.conversationId ?? "");

  for (const id of deps.modelIds) {
    if (signal.aborted) return { cancel: true };
    const model = deps.resolveModel(id);
    if (!model) continue;
    try {
      const response = await deps.complete(model, { messages: summaryMessages }, {
        maxTokens: SUMMARY_MAX_TOKENS,
        signal,
        cacheRetention: "none",
        sessionId: deps.newSessionId(),
        ...(identity ? { headers: { [SESSION_HEADER]: identity } } : {}),
      });
      if (signal.aborted) return { cancel: true };
      const summary = response.text?.trim();
      if (!summary) throw new Error(`class route ${id} returned an empty summary`);
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
        },
      };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { cancel: true };
      }
      deps.notify(
        `pi-mantice: class-route compaction failed on ${id}: ${error instanceof Error ? error.message : error}`,
        "warning",
      );
    }
  }

  if (reason === "manual") {
    deps.notify("pi-mantice: class compaction unavailable, falling through to Pi default", "warning");
    return undefined;
  }
  deps.notify(
    "pi-mantice: flash and fast class routes failed; compaction cancelled to avoid spending the session model on summarization. Retry when the gateway is healthy.",
    "error",
  );
  return { cancel: true };
}
