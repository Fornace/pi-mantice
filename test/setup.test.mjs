import test from 'node:test';
import assert from 'node:assert/strict';
import { classFor, planRegistry } from '../src/setup.ts';
import { classifyUpstream } from '../src/frontier.ts';

function found(modelId, providerId = 'prov-a') {
  return { provider_id: providerId, model_id: modelId };
}

test('class mapping follows frontier tiers and refuses non-text outputs', () => {
  assert.equal(classFor(classifyUpstream('deepseek-v4-flash')), 'flash');
  assert.equal(classFor(classifyUpstream('gpt-5.5')), 'fast');
  assert.equal(classFor(classifyUpstream('gpt-5.5-pro')), 'max');
  const embedding = classifyUpstream('text-embedding-v3');
  if (embedding) assert.equal(classFor(embedding), null, 'embeddings never enter chat classes');
});

test('plan chains classes and orders each by cheapest-newest', () => {
  const plan = planRegistry(
    [{ id: 'prov-a', kind: 'openai', protocol: 'openai', base_url: 'https://a.invalid/v1',
      auth_kind: 'bearer', credential_env: 'PROV_A_API_KEY' }],
    [found('deepseek-v4-flash'), found('gpt-5.5-pro'), found('gpt-5.5')],
  );
  const groups = plan.model_groups.map((g) => g.name);
  assert.ok(groups.includes('max') && groups.includes('fast') && groups.includes('flash'));
  assert.deepEqual(plan.fallbacks.max, ['fast']);
  assert.deepEqual(plan.fallbacks.fast, ['flash']);
  assert.deepEqual(plan.aliases, {}, 'class groups need no alias and aliases may not collide');
  const maxDeps = plan.deployments.filter((d) => d.model_group === 'max');
  assert.equal(maxDeps[0].upstream_model, 'gpt-5.5-pro');
  assert.equal(maxDeps[0].priority, 0);
  const cardLimits = maxDeps[0].params.model_card.limits;
  assert.ok(cardLimits.max_input_tokens > 128_000, 'max deployment carries a real input ceiling');
  const provider = plan.providers[0];
  assert.deepEqual(provider.credential, { api_key_env: 'PROV_A_API_KEY' });
  assert.equal(JSON.stringify(plan).includes('api_key"'), false, 'no inline secrets in plan');
});

test('unknown models are demoted to private groups outside every class chain', () => {
  const plan = planRegistry(
    [{ id: 'prov-a', kind: 'openai', protocol: 'openai', base_url: 'https://a.invalid/v1', auth_kind: 'none' }],
    [found('acme-secretmodel-9000'), found('gpt-5.5')],
  );
  const demoted = plan.model_groups.find((g) => g.name.startsWith('internal-'));
  assert.ok(demoted && demoted.public === false && demoted.enabled === true);
  assert.ok(plan.notes.some((note) => /demoted \S*acme-secretmodel-9000/.test(note)));
  const chained = Object.values(plan.fallbacks).flat();
  assert.equal(chained.includes(demoted.name), false, 'demoted groups never serve as fallbacks');
});

test('classes without candidates are reported and absent, not empty groups', () => {
  const plan = planRegistry(
    [{ id: 'prov-a', kind: 'openai', protocol: 'openai', base_url: 'https://a.invalid/v1', auth_kind: 'none' }],
    [found('deepseek-v4-flash')],
  );
  assert.deepEqual(plan.model_groups.map((g) => g.name), ['flash']);
  assert.deepEqual(plan.fallbacks.flash, []);
  assert.ok(plan.notes.some((n) => n.includes('class max')));
});
