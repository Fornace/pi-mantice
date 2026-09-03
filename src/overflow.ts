// Canonical overflow mapping. Providers and older gateways surface context
// misses in assorted wordings; Pi auto-compacts only on messages it recognizes
// (see packages/ai/src/utils/overflow.ts). This rewrites Mantice-scoped error
// text to the canonical `context_length_exceeded` prefix. Rate limits and
// shape mismatches are never rewritten.

export const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /maximum context length/i,
  /exceeds (the )?model maximum context length/i,
  /input length \(\d+\) exceeds/i,
  /prompt exceeds max length/i,
  /"code"\s*:\s*"?1261"?/,
  /context length/i,
  /too many tokens.*context/i,
];

const ALREADY_CANONICAL = /context_length_exceeded/;
const NEVER_REWRITE = /rate limit|too many requests|429|no healthy provider|no_route_available/i;

export interface AssistantLikeMessage {
  role: string;
  stopReason?: string;
  provider?: string;
  errorMessage?: string | null;
}

export function canonicalOverflowMessage(
  message: AssistantLikeMessage,
  providers: string[],
): string | null {
  if (message.role !== "assistant" || message.stopReason !== "error") return null;
  if (!providers.includes(message.provider ?? "")) return null;
  const original = message.errorMessage ?? "";
  if (!original || ALREADY_CANONICAL.test(original) || NEVER_REWRITE.test(original)) return null;
  if (!OVERFLOW_PATTERNS.some((pattern) => pattern.test(original))) return null;
  return `context_length_exceeded: ${original}`;
}

export function createOverflowHandler(providers: string[]) {
  return (event: { message: AssistantLikeMessage }): { message: AssistantLikeMessage } | undefined => {
    const rewritten = canonicalOverflowMessage(event.message, providers);
    if (!rewritten) return undefined;
    return { message: { ...event.message, errorMessage: rewritten } };
  };
}

// Failover transparency: notify once per changed backend model within a
// provider so operators see route moves without touching context math.
export function createResponseModelWatcher(
  providers: string[],
  notify: (message: string) => void,
) {
  const lastSeen = new Map<string, string>();
  return (message: AssistantLikeMessage & { model?: string; responseModel?: string }): void => {
    if (message.role !== "assistant" || message.stopReason === "error") return;
    const provider = message.provider ?? "";
    if (!providers.includes(provider) || !message.responseModel) return;
    const route = message.model ?? "unknown";
    const seen = `${provider}/${route}`;
    if (lastSeen.get(seen) === message.responseModel) return;
    lastSeen.set(seen, message.responseModel);
    notify(`Mantice route ${route} served by ${message.responseModel}`);
  };
}
