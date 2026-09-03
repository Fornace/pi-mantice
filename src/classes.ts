// Class policy: how Mantice route classes map to Pi behavior. Gateway-owned
// literal ids (fornace-*) are the contract on both sides; unknown public
// groups stay class-less and purely catalog-driven.

export const TEXT_CLASSES = ["max", "reasoning", "fast", "flash"] as const;
export type TextClass = (typeof TEXT_CLASSES)[number];

// Compaction never runs on the session's own class when a cheaper class is
// reachable: flash first, fast as fallback, then hand the turn back to Pi.
export const COMPACTION_CHAIN: TextClass[] = ["flash", "fast"];

export const CLASS_ALIASES: Record<string, TextClass> = {
  "fornace-max": "max",
  "fornace-reasoning": "reasoning",
  "fornace-fast": "fast",
  "fornace-flash": "flash",
};

// Gateway aliases resolve to the same classes (mantice provider only).
export const CLASS_ALIAS_SHORTS: Record<string, TextClass> = {
  max: "max",
  reasoning: "reasoning",
  fast: "fast",
  flash: "flash",
};

export function classOf(row: { id?: string; owned_by?: string | null; class?: string | null }): TextClass | null {
  if (typeof row.class === "string" && (TEXT_CLASSES as readonly string[]).includes(row.class)) {
    return row.class as TextClass;
  }
  if (row.id && CLASS_ALIASES[row.id]) return CLASS_ALIASES[row.id];
  if (row.id && CLASS_ALIAS_SHORTS[row.id]) return CLASS_ALIAS_SHORTS[row.id];
  if (typeof row.owned_by === "string" && row.owned_by.startsWith("alias:")) {
    const target = row.owned_by.slice("alias:".length);
    return CLASS_ALIASES[target] ?? null;
  }
  return null;
}

// Suggested Pi thinkingBudgets snippet per class (offered by setup, never
// auto-written to user settings).
export const THINKING_BUDGET_SNIPPET: Record<TextClass, { minimal: number; low: number; medium: number; high: number }> = {
  max: { minimal: 1024, low: 4096, medium: 16384, high: 65536 },
  reasoning: { minimal: 1024, low: 4096, medium: 16384, high: 65536 },
  fast: { minimal: 512, low: 2048, medium: 8192, high: 32768 },
  flash: { minimal: 256, low: 1024, medium: 4096, high: 16384 },
};
