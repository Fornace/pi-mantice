import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SESSION_HEADER = "X-Mantice-Session-ID";

/** Stable across resume/reload, distinct across new/forked Pi sessions. */
export function gatewaySessionIdentity(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  return `pi-${createHash("sha256")
    .update("pi-mantice-session-v1\0")
    .update(sessionId)
    .digest("hex")}`;
}

export function registerSessionIdentity(api: Pick<ExtensionAPI, "on">): void {
  api.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "mantice" && ctx.model?.provider !== "fornace") return;
    // HTTP names are case-insensitive. Ensure one canonical identity, not an
    // ambiguous pair rejected by Mantice's strict session isolation boundary.
    for (const key of Object.keys(event.headers)) {
      if (key.toLowerCase() === SESSION_HEADER.toLowerCase()) delete event.headers[key];
    }
    const identity = gatewaySessionIdentity(ctx.sessionManager.getSessionId());
    if (identity) event.headers[SESSION_HEADER] = identity;
  });
}
