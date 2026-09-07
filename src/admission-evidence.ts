// Only Mantice's explicit pre-upstream admission contract permits this replay.
// Do not infer acceptance from prose, a status alone, or an echoed request.
export const ADMISSION_CODES = new Set([
  "request_capacity_unavailable", "upload_authentication_unavailable",
  "gateway_draining", "gateway_quiescing",
  "worker_pool_unavailable", "worker_capacity_unavailable",
]);

export function admissionCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const error = value as Record<string, unknown>;
  const details = error.details as Record<string, unknown> | undefined;
  if (error.type !== "gateway_error" || typeof error.code !== "string"
    || !ADMISSION_CODES.has(error.code) || !details || Array.isArray(details)
    || details.retryable !== true || details.upstream_started !== false) return;
  return error.code;
}

export function admissionMessage(message: string | undefined): string | undefined {
  // Exact pi-ai 0.85.1 formatProviderError wrapper, not free-form extraction.
  if (!message?.startsWith("503: ") || message.length > 4096) return;
  try { return admissionCode(JSON.parse(message.slice(5))); } catch { return; }
}

export async function admissionResponse(response: Response): Promise<string | undefined> {
  if (response.status !== 503 || response.redirected
    || response.headers.get("x-should-retry") === "false"
    || response.headers.get("x-mantice-admission") !== "not-started-v1") return;
  const copy = response.clone();
  const reader = copy.body?.getReader();
  if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("admission evidence timeout")), 1000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) return;
      chunks.push(value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return admissionCode(body?.error);
  } catch {
    return;
  } finally {
    clearTimeout(timer);
    // A tee cancellation can wait for the SDK's original body consumer.
    // Never await it here: that consumer has not received the Response yet.
    void reader.cancel().catch(() => {});
  }
}

export function admissionDelay(header: string | null, now: number): number | undefined {
  if (header === null) return 0;
  const value = header.trim();
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000 : Date.parse(value) - now;
  // Do not shorten a long Retry-After. Leave it to the normal caller policy.
  if (!Number.isFinite(milliseconds) || milliseconds > 3_600_000) return;
  return Math.max(0, milliseconds);
}
