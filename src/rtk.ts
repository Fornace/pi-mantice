import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// RTK owns command recognition and shell syntax. Pi executes the rewritten
// command once; this hook only asks RTK to classify and rewrite its text.
export function registerRtk(api: ExtensionAPI): { reset: () => void } {
  let unavailable = false;
  api.on("tool_call", async (event, ctx) => {
    if (unavailable || process.env.RTK_DISABLED === "1"
      || !isToolCallEventType("bash", event)
      || (ctx.model?.provider !== "mantice" && ctx.model?.provider !== "fornace")) return;
    const command = event.input.command;
    if (typeof command !== "string" || !command.trim() || command.trimStart().startsWith("rtk ")) return;
    try {
      const result = await api.exec("rtk", ["rewrite", command], { timeout: 2000, signal: ctx.signal });
      if (!result.killed && (result.code === 0 || result.code === 3) && result.stdout.trim()) {
        event.input.command = result.stdout.trim();
      }
    } catch {
      if (ctx.signal?.aborted) return;
      unavailable = true;
      ctx.ui.notify("pi-mantice: RTK unavailable; install rtk for compact command output. Pruning remains active.", "warning");
    }
  });
  return { reset: () => { unavailable = false; } };
}
