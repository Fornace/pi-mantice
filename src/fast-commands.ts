import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fastPreview, fastStatus } from "./fast-inspection.ts";
import { SUMMARY_CARRY_BYTES } from "./summary-chunks.ts";

const COMMANDS = [
  { value: "session", label: "session [focus]", description: "Compact now with Mantice flash/fast" },
  { value: "preview", label: "preview", description: "Estimate pruning savings; no model call" },
  { value: "status", label: "status", description: "Context, model and saved compaction progress" },
  { value: "rtk", label: "rtk", description: "Check RTK and restore native integration" },
  { value: "help", label: "help", description: "Show these commands" },
];
const HELP = COMMANDS.map(command => `/fast ${command.label} — ${command.description}`).join("\n");

export function registerFastCommands(api: ExtensionAPI, options: {
  modelIds: () => string[];
  resetRtk: () => void;
}): { isCompacting: (sessionId: string) => boolean } {
  const running = new Set<string>();
  api.registerCommand("fast", {
    description: "Mantice: session compaction, pruning preview, status and RTK",
    getArgumentCompletions: prefix => {
      const query = prefix.trimStart().toLowerCase();
      return COMMANDS.filter(command => command.value.startsWith(query));
    },
    handler: async (args, ctx) => {
      // Fixed slash-command grammar: one command token, optional free-text focus.
      const input = args.trim();
      const boundary = input.search(/\s/u);
      const command = (boundary < 0 ? input : input.slice(0, boundary)).toLowerCase();
      const focus = boundary < 0 ? "" : input.slice(boundary).trim();
      if (!command || command === "help") { ctx.ui.notify(HELP, "info"); return; }
      if (!COMMANDS.some(item => item.value === command) || (focus && command !== "session")) {
        ctx.ui.notify(`Unknown fast command.\n${HELP}`, "warning"); return;
      }
      try {
        if (command === "preview") { ctx.ui.notify(fastPreview(ctx), "info"); return; }
        if (command === "status") {
          ctx.ui.notify(fastStatus(ctx, running.has(ctx.sessionManager.getSessionId()), options.modelIds()), "info");
          return;
        }
        if (command === "rtk") { await checkRtk(api, ctx, options.resetRtk); return; }
        if (ctx.model?.provider !== "mantice" && ctx.model?.provider !== "fornace") {
          ctx.ui.notify("Select a Mantice model before /fast session.", "warning"); return;
        }
        if (!options.modelIds().length) {
          ctx.ui.notify("Mantice flash/fast summarizers are unavailable. /fast status shows the current catalog.", "warning"); return;
        }
        const id = ctx.sessionManager.getSessionId();
        if (running.has(id)) { ctx.ui.notify("Fast compaction is already running.", "info"); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("Finish or cancel the current turn and queued messages, then run /fast session.", "warning"); return;
        }
        if (Buffer.byteLength(focus, "utf8") > SUMMARY_CARRY_BYTES) {
          ctx.ui.notify("Compaction focus is too long.", "warning"); return;
        }
        running.add(id);
        ctx.ui.notify("Fast compaction started. Original history remains recoverable.", "info");
        try {
          ctx.compact({
            ...(focus ? { customInstructions: focus } : {}),
            onComplete: () => { running.delete(id); ctx.ui.notify("Fast compaction complete.", "info"); },
            onError: error => {
              running.delete(id);
              if (error.message === "Nothing to compact (session too small)" || error.message === "Already compacted") {
                ctx.ui.notify("Session is already compact; nothing to do.", "info");
              } else ctx.ui.notify(`Fast compaction stopped: ${error.message}`, "warning");
            },
          });
        } catch (error) { running.delete(id); throw error; }
      } catch (error) {
        ctx.ui.notify(`Fast command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  return { isCompacting: id => running.has(id) };
}

async function checkRtk(api: ExtensionAPI, ctx: ExtensionCommandContext, reset: () => void): Promise<void> {
  const version = await api.exec("rtk", ["--version"], { timeout: 2000, signal: ctx.signal });
  if (version.killed || version.code !== 0) throw new Error("RTK unavailable; install rtk on PATH.");
  const rewrite = await api.exec("rtk", ["rewrite", "git status --short"], { timeout: 2000, signal: ctx.signal });
  if (rewrite.killed || (rewrite.code !== 0 && rewrite.code !== 3) || !rewrite.stdout.trim()) {
    throw new Error("RTK command rewriting failed; update rtk.");
  }
  reset();
  ctx.ui.notify(`${version.stdout.trim()} · rewrite check passed · ${process.env.RTK_DISABLED === "1" ? "disabled by RTK_DISABLED=1" : "native integration ready"}. Probe only; git was not executed.`, "info");
}
