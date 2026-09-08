// RTK-backed fast file tools for Mantice sessions. The native read/write
// tools stay untouched; these expose RTK's filtered read and heuristic smart
// summary as first-class tools so re-reading files after mechanical
// compaction is cheap. Registered only when the rtk binary is on PATH.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RTK_TIMEOUT_MS = 15_000;

function run(api: ExtensionAPI, args: string[], signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("rtk", args, { timeout: RTK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error && !stdout.trim()) reject(new Error(`rtk ${args[0]} failed: ${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
        else resolve(stdout);
      });
    child.on("error", reject);
  });
}

function resolvePath(raw: string, cwd: string): string {
  return isAbsolute(raw) ? raw : join(cwd, raw);
}

export async function registerRtkTools(api: ExtensionAPI): Promise<boolean> {
  const probe = await api.exec("rtk", ["--version"], { timeout: 2_000 });
  if (probe.killed || probe.code !== 0) return false;

  api.registerTool({
    name: "fast_read",
    label: "Fast Read",
    description: "Read a text file through RTK filtering. Levels: minimal (strip comments/blank lines) or aggressive (code skeleton, no bodies). Use for orientation and re-reads after compaction; use the native read tool when exact full content is required.",
    promptSnippet: "Read files cheaply with RTK filtering (fast_read)",
    promptGuidelines: ["Use fast_read instead of read when a filtered view is enough (large files, re-reading known files after compaction); prefer level aggressive first, minimal if bodies are needed."],
    parameters: Type.Object({
      path: Type.String({ description: "File path, absolute or relative to the working directory" }),
      level: Type.Optional(Type.Union([
        Type.Literal("minimal"),
        Type.Literal("aggressive"),
      ], { description: "Filter level, default minimal" })),
      maxLines: Type.Optional(Type.Number({ description: "Keep only the first N lines" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const path = resolvePath(params.path, ctx.cwd);
      const args = ["read", "--level", params.level ?? "minimal"];
      if (typeof params.maxLines === "number" && params.maxLines > 0) args.push("--max-lines", String(Math.floor(params.maxLines)));
      args.push(path);
      const stdout = await run(api, args, signal);
      const text = stdout.trimEnd() || "(empty after RTK filtering; retry with the native read tool for full content)";
      return {
        content: [{ type: "text", text }],
        details: { command: `rtk ${args.join(" ")}` },
      };
    },
  });

  api.registerTool({
    name: "fast_write",
    label: "Fast Write",
    description: "Write a file and return a two-line RTK heuristic summary instead of full content echo. Same result as the native write tool plus a compact verification receipt.",
    promptSnippet: "Write files with an RTK summary receipt (fast_write)",
    promptGuidelines: ["Use fast_write instead of write when a compact verification receipt is enough; the receipt summarizes the written file in two lines."],
    parameters: Type.Object({
      path: Type.String({ description: "File path, absolute or relative to the working directory" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const path = resolvePath(params.path, ctx.cwd);
      await writeFile(path, params.content, "utf8");
      const summary = (await run(api, ["smart", path], signal)).trim();
      const bytes = Buffer.byteLength(params.content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${bytes} bytes to ${path}.\nRTK summary: ${summary || "(unavailable)"}` }],
        details: { path, bytes },
      };
    },
  });
  return true;
}
