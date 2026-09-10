import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fastPreview, fastStatus } from "./fast-inspection.ts";

const SUMMARY_CARRY_BYTES = 128_000;

export interface MechanicalGate {
  /** Arm mechanical stage for one session; consumed by the next compaction. */
  arm: (sessionId: string) => void;
  /** Consume the armed state; true exactly once per arm(). */
  consume: (sessionId: string) => boolean;
  /** Whether the session is currently armed. */
  has: (sessionId: string) => boolean;
}

export function createMechanicalGate(): MechanicalGate {
  const armed = new Set<string>();
  return {
    arm: id => armed.add(id),
    consume: id => armed.delete(id),
    has: id => armed.has(id),
  };
}

export interface CompactionStats {
  tokensBefore?: number;
  digestBytes?: number;
  removedMessages?: number;
  prunedMessages?: number;
}

const COMMANDS = [
  { value: "session", label: "session [focus]", description: "Mechanical compaction: RTK-style digest, zero model calls" },
  { value: "preview", label: "preview", description: "Estimate pruning savings; no model call" },
  { value: "status", label: "status", description: "Context and model status" },
  { value: "rtk", label: "rtk", description: "Check RTK and restore native integration" },
  { value: "help", label: "help", description: "Show these commands" },
];
const HELP = [
  ...COMMANDS.map(command => `/fast ${command.label} — ${command.description}`),
  "/compact — stage two: Pi native AI-assisted compaction of the pruned context",
].join("\n");

export function registerFastCommands(api: ExtensionAPI, options: {
  resetRtk: () => void;
  gate: MechanicalGate;
  stats: CompactionStats;
}): { isCompacting: (sessionId: string) => boolean } {
  const running = new Set<string>();
  // Agent-initiated /fast session: the fast_session tool arms the gate; the
  // compaction itself fires on the first agent_settled where the session is
  // idle, so it never aborts an active run.
  const pendingAgentFast = new Map<string, string>();

  const beginStats = () => {
    options.stats.tokensBefore = undefined;
    options.stats.digestBytes = undefined;
    options.stats.removedMessages = undefined;
    options.stats.prunedMessages = undefined;
  };

  api.on("agent_settled", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const focus = pendingAgentFast.get(id);
    if (focus === undefined) return;
    if (running.has(id)) return;
    if (!options.gate.has(id)) {
      // A compaction already consumed the gate (e.g. threshold auto-compaction
      // turned mechanical while armed); the goal is already met.
      pendingAgentFast.delete(id);
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    pendingAgentFast.delete(id);
    running.add(id);
    const started = Date.now();
    beginStats();
    ctx.compact({
      ...(focus ? { customInstructions: focus } : {}),
      onComplete: () => {
        running.delete(id);
        const tokens = options.stats.tokensBefore;
        const digest = options.stats.digestBytes;
        const reduction = tokens && digest
          ? ` · context span reduced ~${Math.max(0, 100 - Math.round((digest / 4 / tokens) * 100))}%`
          : "";
        ctx.ui.notify(`fast_session tool: mechanical compaction complete in ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
          `${options.stats.removedMessages ?? 0} messages replaced by a ` +
          `${((digest ?? 0) / 1024).toFixed(1)} KiB digest · zero model calls${reduction}.`, "info");
      },
      onError: error => {
        running.delete(id);
        options.gate.consume(id);
        if (error.message === "Nothing to compact (session too small)" || error.message === "Already compacted") {
          ctx.ui.notify("fast_session: session is already compact; nothing to do.", "info");
        } else ctx.ui.notify(`fast_session mechanical compaction stopped: ${error.message}`, "warning");
      },
    });
  });

  api.registerCommand("fast", {
    description: "Mantice: mechanical session compaction, pruning preview, status and RTK",
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
          ctx.ui.notify(fastStatus(ctx, running.has(ctx.sessionManager.getSessionId())), "info");
          return;
        }
        if (command === "rtk") { await checkRtk(api, ctx, options.resetRtk); return; }
        const id = ctx.sessionManager.getSessionId();
        if (running.has(id)) { ctx.ui.notify("Mechanical compaction is already running.", "info"); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("Finish or cancel the current turn and queued messages, then run /fast session.", "warning"); return;
        }
        if (Buffer.byteLength(focus, "utf8") > SUMMARY_CARRY_BYTES) {
          ctx.ui.notify("Compaction focus is too long.", "warning"); return;
        }
        running.add(id);
        const started = Date.now();
        beginStats();
        options.gate.arm(id);
        ctx.ui.notify("Mechanical compaction started. Zero model calls; original history remains recoverable.", "info");
        try {
          ctx.compact({
            ...(focus ? { customInstructions: focus } : {}),
            onComplete: () => {
              running.delete(id);
              const tokens = options.stats.tokensBefore;
              const digest = options.stats.digestBytes;
              const reduction = tokens && digest
                ? ` · context span reduced ~${Math.max(0, 100 - Math.round((digest / 4 / tokens) * 100))}%`
                : "";
              ctx.ui.notify(`Mechanical compaction complete in ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
                `${options.stats.removedMessages ?? 0} messages replaced by a ` +
                `${((digest ?? 0) / 1024).toFixed(1)} KiB digest · zero model calls${reduction}.`, "info");
            },
            onError: error => {
              running.delete(id);
              if (error.message === "Nothing to compact (session too small)" || error.message === "Already compacted") {
                ctx.ui.notify("Session is already compact; nothing to do.", "info");
              } else ctx.ui.notify(`Mechanical compaction stopped: ${error.message}`, "warning");
            },
          });
        } catch (error) { running.delete(id); throw error; }
      } catch (error) {
        ctx.ui.notify(`Fast command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // Agent-callable twin of /fast session: arms the mechanical gate mid-turn
  // and fires the same ctx.compact() path on agent_settled. The tool never
  // compacts inline because compaction aborts the active agent run.
  api.registerTool({
    name: "fast_session",
    label: "Fast Session",
    description: "Run mechanical context compaction (the /fast session command) from the agent, without waiting for the user. Arms a zero-model-call mechanical digest that executes the moment the session turns idle. Call it when context usage approaches 50% on mantice/fornace models, then finish the current reply.",
    promptSnippet: "Run /fast session mechanical compaction from the agent (fast_session)",
    promptGuidelines: [
      "Use fast_session as soon as context usage approaches 50% on mantice/fornace providers; after calling it, finish the current reply so the mechanical compaction can run.",
    ],
    parameters: Type.Object({
      focus: Type.Optional(Type.String({ description: "Optional focus hint carried into the mechanical digest" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = ctx.sessionManager.getSessionId();
      const focus = (params.focus ?? "").trim();
      if (running.has(id)) {
        return { content: [{ type: "text", text: "Mechanical compaction is already running." }], details: { armed: false } };
      }
      if (pendingAgentFast.has(id) || options.gate.has(id)) {
        return { content: [{ type: "text", text: "Mechanical compaction is already armed for this session; it runs when the session settles." }], details: { armed: true } };
      }
      if (Buffer.byteLength(focus, "utf8") > SUMMARY_CARRY_BYTES) {
        return { content: [{ type: "text", text: "Compaction focus is too long." }], details: { armed: false } };
      }
      const usage = ctx.getContextUsage();
      pendingAgentFast.set(id, focus);
      options.gate.arm(id);
      return {
        content: [{ type: "text", text: `Mechanical compaction armed${usage?.percent == null ? "" : ` at ${usage.percent.toFixed(1)}% context`}. ` +
          "Finish this turn; the digest replaces the summarized span with zero model calls the moment the session settles. " +
          `Original history stays recoverable in the session JSONL. Focus: ${focus || "(none)"}` }],
        details: { armed: true, focus, contextPercent: usage?.percent },
      };
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
