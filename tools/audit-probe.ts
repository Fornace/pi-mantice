// Audit probe: dumps the fully resolved Pi model registry at session start
// so tools/audit.mjs can compare it against the live Mantice catalog.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function register(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const out = process.env.PI_MANTICE_AUDIT_OUT;
    if (!out) return;
    const dump = ctx.modelRegistry.getAll().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: model.input,
    }));
    writeFileSync(out, JSON.stringify(dump, null, 2));
  });
}
