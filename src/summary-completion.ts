import {
  retryAssistantCall,
  type AssistantMessage,
  type RetryPolicy,
} from "@earendil-works/pi-ai";

export class CompactionPolicyError extends Error {
  constructor() {
    super("Compaction rejected by upstream policy; transcript preserved without retry or rerouting.");
    this.name = "CompactionPolicyError";
  }
}

// Known machine error identifiers. Conservative substring matching also covers
// SDK wrappers around the JSON response; no attempt to infer policy from prose.
const POLICY_CODES = [
  "content_policy_violation", "DataInspectionFailed",
  "ResponsibleAIPolicyViolation", "content_filter",
];

export async function completeSummaryWithRetry(
  produce: () => Promise<AssistantMessage>,
  policy: RetryPolicy,
  signal: AbortSignal,
  notify: (message: string) => void,
): Promise<AssistantMessage> {
  return retryAssistantCall(async () => {
    if (signal.aborted) {
      const error = new Error("Compaction aborted");
      error.name = "AbortError";
      throw error;
    }
    const response = await produce();
    if (response.stopReason === "error"
      && POLICY_CODES.some((code) => response.errorMessage?.includes(code))) {
      throw new CompactionPolicyError();
    }
    return response;
  }, policy, signal, {
    onRetryScheduled: (attempt, maxAttempts, delayMs) => {
      notify(`pi-mantice: transient compaction failure; retry ${attempt}/${maxAttempts} in ${Math.ceil(delayMs / 1000)}s`);
    },
  });
}
