#!/usr/bin/env node
// /mantice-setup CLI: probe, discover, classify, show plan, APPLY, publish.
//
//   node tools/setup.mjs --config setup.json [--replace] [--allow-prod]
//
// setup.json:
// {
//   "gateway": { "base_url": "http://127.0.0.1:8080", "token_env": "ADMIN_TOKEN" },
//   "providers": [
//     { "id": "zai", "kind": "openai", "protocol": "openai",
//       "base_url": "https://api.z.ai/api/pai/v1", "auth_kind": "bearer",
//       "credential_env": "ZAI_API_KEY" }
//   ]
// }
// credential_env is read from THIS process's environment and posted inline;
// values are never printed.

import { readFileSync } from "node:fs";
import { planRegistry } from "../src/setup.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const flagValue = (name) => {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const configPath = flagValue("config");
if (!configPath) {
  console.error("usage: node tools/setup.mjs --config setup.json [--replace] [--allow-prod]");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const base = String(config.gateway?.base_url ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const token = process.env[config.gateway?.token_env ?? "ADMIN_TOKEN"];
if (!token) {
  console.error(`gateway admin token missing in env ${config.gateway?.token_env ?? "ADMIN_TOKEN"}`);
  process.exit(2);
}

const PROD_HOSTS = [/llm\.fornace\.net/i, /fornace-llm/i];
const hostname = new URL(base).hostname;
if (PROD_HOSTS.some((pattern) => pattern.test(hostname) || pattern.test(base))) {
  if (!flags.has("--allow-prod")) {
    console.error("refusing to write to a production Fornace gateway; this tool is for your own gateway");
    process.exit(3);
  }
  console.error("--allow-prod requested against a Fornace production host. Type PROCEED to continue.");
  const answer = readFileSync(0, { encoding: "utf8", flag: "r" }).trim();
  if (answer !== "PROCEED") {
    console.error("aborted.");
    process.exit(3);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.json()).catch(() => null);
if (!health) { console.error(`gateway unreachable at ${base}`); process.exit(4); }

const current = await api("/admin/routing");
const hasRegistry = (current.model_groups?.length ?? 0) > 0;
if (hasRegistry && !flags.has("--replace")) {
  console.error(`gateway already routes ${current.model_groups.length} groups; pass --replace to overwrite atomically`);
  process.exit(5);
}

for (const provider of config.providers ?? []) {
  const secret = provider.credential_env ? process.env[provider.credential_env] : undefined;
  if (provider.credential_env && !secret && provider.auth_kind !== "none") {
    console.error(`credential env ${provider.credential_env} empty for provider ${provider.id}`);
    process.exit(4);
  }
  await api("/admin/providers", { method: "POST", body: JSON.stringify({
    id: provider.id, name: provider.name ?? provider.id, kind: provider.kind,
    protocol: provider.protocol, base_url: provider.base_url, auth_kind: provider.auth_kind,
    credential: secret ? { api_key: secret } : {}, timeout_ms: 180000, enabled: true,
  }) });
  console.error(`provider upserted: ${provider.id}`);
}
await api("/admin/providers/discover", { method: "POST" }).catch((error) => {
  console.error(`bulk discovery failed (${error.message}); relying on existing inventory`);
});
const inventory = (await api("/admin/discovery")).data ?? [];
const discovered = inventory
  .filter((row) => (config.providers ?? []).some((p) => p.id === row.provider_id))
  .map((row) => ({ provider_id: row.provider_id, model_id: row.model_id }));
console.error(`discovered ${discovered.length} models across ${config.providers?.length ?? 0} providers`);

const plan = planRegistry(config.providers ?? [], discovered);
console.error("\n--- routing plan -------------------------------------------------\n");
console.log(JSON.stringify({
  model_groups: plan.model_groups, aliases: plan.aliases, fallbacks: plan.fallbacks,
  deployments: plan.deployments.map((d) => ({ id: d.id, provider_id: d.provider_id,
    model_group: d.model_group, upstream_model: d.upstream_model, priority: d.priority })),
  notes: plan.notes,
}, null, 2));
console.error("\n--- end plan -------------------------------------------------------");
console.error(`providers (secrets withheld): ${plan.providers.map((p) => `${p.id} <- ${p.credential.api_key_env}`).join(", ")}`);

if (!plan.model_groups.length) {
  console.error("nothing classified; refusing to publish an empty registry");
  process.exit(6);
}
console.error("Type APPLY (exactly) to publish this plan with revision CAS:");
const answer = readFileSync(0, { encoding: "utf8", flag: "r" }).trim();
if (answer !== "APPLY") { console.error("not applied; plan printed above is the only change artifact."); process.exit(0); }

// Providers were already upserted with their credentials during discovery;
// publish routing only and reuse the server-side provider records so inline
// secrets are never re-posted or replaced by env references.
const fresh = await api("/admin/routing");
await api("/admin/routing/reset", { method: "POST", body: JSON.stringify({
  providers: fresh.providers, deployments: plan.deployments, model_groups: plan.model_groups,
  aliases: plan.aliases, fallbacks: plan.fallbacks, if_revision: fresh.revision,
}) });
for (let attempt = 0; attempt < 30; attempt += 1) {
  const after = await api("/admin/routing");
  if (after.revision !== fresh.revision && (after.model_groups?.length ?? 0) === plan.model_groups.length) {
    console.error(`published: revision ${after.revision.slice(0, 12)}…, ${after.model_groups.length} groups`);
    process.exit(0);
  }
  await sleep(500);
}
console.error("publish did not verify within 15s; inspect /admin/routing before retrying");
process.exit(7);
