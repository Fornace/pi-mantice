import { setTimeout as sleep } from "node:timers/promises";
import {
  lazyStream,
  type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { admissionDelay, admissionMessage, admissionResponse } from "./admission-evidence.ts";

export interface AdmissionRecovery {
  enabled(): boolean;
  notify(message: string): void;
  // Injectable clock wait for disposable fault exercises, not user configuration.
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
}

// Pi 0.85.1 fixes RPC abort propagation to the compaction controller.
// Unknown/prerelease versions are not evidence that cancellation is safe.
export function supportsCompactionRecovery(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 0 || minor > 85 || (minor === 85 && patch >= 1);
}

// Use a dynamic import type for the stream function to avoid jiti converting it to a failing require()
type StreamSimple = typeof import("@earendil-works/pi-ai/api/openai-completions").streamSimple;

export function admissionStream(
  model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined,
  recovery: AdmissionRecovery,
  streamSimple: StreamSimple,
) {
  if (!options?.signal || !recovery.enabled()) {
    return streamSimple(model as Model<"openai-completions">, context, options);
  }
  const notify = (message: string) => {
    try { recovery.notify(message); } catch { /* UI failure is not a transport failure. */ }
  };
  return lazyStream(model, async () => (async function* (): AsyncGenerator<AssistantMessageEvent> {
    const signal = options?.signal;
    const upstream = options?.fetch ?? globalThis.fetch;
    let retries = 0;
    while (true) {
      let requests = 0;
      let allUnstarted = true;
      let retryAfter = 0;
      let emitted = false;
      let retry: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        requests++;
        try {
          const response = await upstream(input, init);
          const code = await admissionResponse(response);
          const delay = admissionDelay(response.headers.get("retry-after"), Date.now());
          if (!code || delay === undefined) allUnstarted = false;
          else retryAfter = Math.max(retryAfter, delay);
          return response;
        } catch (error) {
          // A lost response cannot establish whether work was accepted.
          allUnstarted = false;
          throw error;
        }
      };
      for await (const event of streamSimple(model as Model<"openai-completions">, context, {
        ...options, fetch,
      })) {
        if (event.type === "error" && event.reason === "error" && !emitted
          && !event.error.content.length && requests > 0 && allUnstarted
          && admissionMessage(event.error.errorMessage) && signal && !signal.aborted
          && recovery.enabled()) {
          retry = event;
          continue;
        }
        emitted = true;
        yield event;
      }
      if (!retry || !signal) {
        if (retries && emitted) notify("Mantice admission wait ended.");
        return;
      }
      retries++;
      const delay = Math.max(retryAfter, 30_000 + Math.floor((recovery.jitter?.() ?? Math.random()) * 30_000));
      notify(`Mantice has not started this request; retrying admission in ${Math.ceil(delay / 1000)}s. Cancel to stop.`);
      try {
        await (recovery.wait ?? ((ms, abort) => sleep(ms, undefined, { signal: abort })))(delay, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        yield { type: "error", reason: "aborted", error: {
          ...retry.error, stopReason: "aborted", errorMessage: "Request was aborted",
        } };
        return;
      }
      if (!recovery.enabled()) { yield retry; return; }
      // Same captured model/context/options; no new user message, route change,
      // history pruning, background actor or accepted-request replay.
    }
  })());
}
