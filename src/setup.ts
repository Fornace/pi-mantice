// /mantice-setup planner: turn discovered provider models into a class-based
// routing registry using the deterministic pi-frontier snapshot. Unknown
// models never enter a class chain; they become private single-model groups
// the operator can promote by hand.

import { bestOfTier, classifyUpstream, type FrontierModel } from "./frontier.ts";

export interface SetupProvider {
  id: string;
  name?: string;
  kind: string;
  protocol: string;
  base_url: string;
  auth_kind: string;
  credential_env?: string;
  credential_inline?: string;
}

export interface DiscoveredModel {
  provider_id: string;
  model_id: string;
}

export interface PlanOptions {
  gatewayTitle?: string;
  classes?: readonly string[];
}

export interface RoutingPlan {
  providers: unknown[];
  deployments: unknown[];
  model_groups: unknown[];
  aliases: Record<string, string>;
  fallbacks: Record<string, string[]>;
  notes: string[];
}

const TIER_CLASS: Record<string, string> = {
  opus: "max", pro: "max",
  reasoning: "reasoning",
  sonnet: "fast", base: "fast", code: "fast",
  flash: "flash", lite: "flash", mini: "flash", nano: "flash",
};

const CLASS_FALLBACKS: Record<string, string[]> = {
  max: ["fast"], reasoning: ["fast"], fast: ["flash"], flash: [],
};

export const DEFAULT_CLASSES = ["max", "reasoning", "fast", "flash"] as const;

function card(model: FrontierModel): unknown {
  return {
    model_card: {
      limits: {
        max_input_tokens: model.max_input_tokens ?? 0,
        max_output_tokens: model.max_output_tokens ?? 0,
      },
      defaults: { max_output_tokens: Math.min(model.max_output_tokens ?? 8192, 8192) },
      capabilities: {
        vision: (model.modalities?.input ?? []).includes("image"),
        reasoning: model.reasoning === true || model.tier === "reasoning",
      },
      reasoning: {
        mode: model.reasoning ? "hybrid" : "none",
        ...(model.reasoning ? { toggle_parameter: "reasoning_effort" } : {}),
      },
    },
  };
}

export function classFor(model: FrontierModel | null): string | null {
  if (!model?.tier) return null;
  // Only conversational models may enter a chat class: frontier knows output
  // modalities, so embeddings and image/video generators are never claimed.
  const outputs = model.modalities?.output;
  if (outputs !== undefined && !outputs.includes("text")) return null;
  return TIER_CLASS[model.tier.toLowerCase()] ?? null;
}

export function planRegistry(
  providers: SetupProvider[],
  discovered: DiscoveredModel[],
  options: PlanOptions = {},
): RoutingPlan {

  const classes = options.classes ?? DEFAULT_CLASSES;
  const notes: string[] = [];
  const byClass = new Map<string, { rank: number; key: string; provider_id: string; model_id: string; model: FrontierModel }[]>();
  const demoted: { provider_id: string; model_id: string; reason: string }[] = [];

  for (const found of discovered) {
    if (!found.model_id) continue;
    const frontier = classifyUpstream(found.model_id);
    if (!frontier) {
      demoted.push({ ...found, reason: "absent from pi-frontier snapshot" });
      continue;
    }
    const klass = classFor(frontier);
    if (!klass || !classes.includes(klass)) {
      demoted.push({ ...found, reason: `tier ${frontier.tier} maps outside the configured classes` });
      continue;
    }
    const entries = byClass.get(klass) ?? [];
    entries.push({ rank: 0, key: `${found.provider_id}/${found.model_id}`,
      provider_id: found.provider_id, model_id: found.model_id, model: frontier });
    byClass.set(klass, entries);
  }

  const deployments: unknown[] = [];
  const modelGroups: unknown[] = [];
  const fallbacks: Record<string, string[]> = {};

  for (const klass of classes) {
    const entries = (byClass.get(klass) ?? []).sort((left, right) =>
      (left.model.input_cost ?? Infinity) - (right.model.input_cost ?? Infinity)
      || String(right.model.release_date ?? "").localeCompare(String(left.model.release_date ?? "")));
    if (!entries.length) {
      notes.push(`class ${klass}: no candidate models (frontier tier or discovery gap)`);
      continue;
    }
    entries.forEach((entry, index) => {
      deployments.push({
        id: `${klass}-${index + 1}`,
        provider_id: entry.provider_id,
        model_group: klass,
        upstream_model: entry.model_id,
        priority: index,
        weight: 1,
        enabled: true,
        input_cost_per_token: entry.model.input_cost ?? 0,
        output_cost_per_token: entry.model.output_cost ?? 0,
        params: card(entry.model),
      });
    });
    modelGroups.push({ name: klass, mode: "chat", enabled: true, public: true, auto_optimize: false });
    fallbacks[klass] = (CLASS_FALLBACKS[klass] ?? []).filter((target) =>
      classes.includes(target) && (byClass.get(target)?.length ?? 0) > 0);
  }

  for (const found of demoted) {
    const groupName = `internal-${found.provider_id}-${found.model_id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
    deployments.push({
      id: `${groupName}-1`, provider_id: found.provider_id, model_group: groupName,
      upstream_model: found.model_id, priority: 0, weight: 1, enabled: true,
      input_cost_per_token: 0, output_cost_per_token: 0, params: {},
    });
    modelGroups.push({ name: groupName, mode: "chat", enabled: true, public: false, auto_optimize: false });
    fallbacks[groupName] = [];
    notes.push(`demoted ${found.provider_id}/${found.model_id}: ${found.reason}`);
  }

  const vision = bestOfTier("flash", { vision: true });
  if (vision) notes.push(`compaction reviewer candidate: ${vision.model_key}`);

  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      kind: provider.kind,
      protocol: provider.protocol,
      base_url: provider.base_url,
      auth_kind: provider.auth_kind,
      // Only env references appear in the plan; inline secrets never reach
      // the printed document. The CLI materializes them as env vars first.
      credential: { api_key_env: provider.credential_env ?? `${provider.id.toUpperCase()}_API_KEY` },
      adapters: {},
      timeout_ms: 180_000,
      enabled: true,
    })),
    deployments,
    model_groups: modelGroups,
    // No aliases: a class group is already addressable by its own name, and
    // an alias colliding with a model-group name is rejected by the gateway.
    aliases: {},
    fallbacks,
    notes,
  };
}
