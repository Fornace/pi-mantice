import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_WINDOW, assertFornaceMaxCapacity, buildProviderModels,
  compactionModelIds, hasCapabilities, isChatRow, parseCatalog,
} from '../src/catalog.ts';
import { COMPACTION_CHAIN, classOf } from '../src/classes.ts';

const capabilityRows = parseCatalog({
  data: [
    { id: 'fornace-max', owned_by: 'routing', context_window: 1050000, max_output_tokens: 1048576,
      mode: 'chat', class: 'max', input_modalities: ['text', 'image'], output_modalities: ['text'],
      supports_tools: true, thinking: { modes: ['enabled', 'disabled'], efforts: ['low', 'high', 'max'] } },
    { id: 'max', owned_by: 'alias:fornace-max', context_window: 1050000, max_output_tokens: 1048576,
      mode: 'chat', class: 'max' },
    { id: 'fornace-flash', owned_by: 'routing', context_window: 1000000, max_output_tokens: 65536,
      mode: 'chat', class: 'flash', thinking: { modes: ['enabled'], efforts: ['low'] } },
    { id: 'flash', owned_by: 'alias:fornace-flash', context_window: 1000000, max_output_tokens: 65536,
      mode: 'chat', class: 'flash' },
    { id: 'fornace-image-max', owned_by: 'routing', context_window: 65536, max_output_tokens: 32768,
      mode: 'image', class: 'image', input_modalities: ['text', 'image'], output_modalities: ['image'] },
  ],
});

const legacyRows = parseCatalog({
  data: [
    { id: 'fornace-max', owned_by: 'routing', context_window: 1050000, max_output_tokens: 1048576 },
    { id: 'fornace-image-max', owned_by: 'routing', context_window: 65536, max_output_tokens: 32768 },
  ],
});

test('capability tier is detected and excludes non-chat by mode', () => {
  assert.equal(hasCapabilities(capabilityRows), true);
  assert.equal(isChatRow(capabilityRows.find((r) => r.id === 'fornace-image-max'), true), false);
});

test('legacy tier excludes non-chat by literal table and warns once', () => {
  assert.equal(hasCapabilities(legacyRows), false);
  const warnings = [];
  const models = buildProviderModels(legacyRows, 'mantice', (m) => warnings.push(m));
  assert.equal(models.find((m) => m.id === 'fornace-image-max'), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no capability fields/);
});

test('capability rows build exact Pi metadata from structured fields', () => {
  const models = buildProviderModels(capabilityRows, 'mantice');
  const max = models.find((m) => m.id === 'fornace-max');
  assert.deepEqual(max, {
    id: 'fornace-max', name: 'Fornace Max', reasoning: true, input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000, maxTokens: 1048576,
  });
  assert.equal(models.find((m) => m.id === 'fornace-flash').reasoning, true);
});

test('capability tier fails closed on missing mode-tier fields', () => {
  const broken = parseCatalog({ data: [...capabilityRows.map((r) => ({ ...r })),
    { id: 'fornace-new', owned_by: 'routing', mode: 'chat' }] });
  assert.throws(() => buildProviderModels(broken, 'mantice'), /fornace-new.*missing context_window/);
});

test('fornace-max capacity assertion holds in both tiers', () => {
  assert.throws(() => assertFornaceMaxCapacity(
    legacyRows.map((r) => r.id === 'fornace-max' ? { ...r, context_window: 128000 } : r)),
    /must exceed 128000/);
  assert.throws(() => assertFornaceMaxCapacity([]), /missing required fornace-max/);
});

test('legacy defaults apply without assertion failure', () => {
  const models = buildProviderModels(
    parseCatalog({ data: [{ id: 'fornace-max', context_window: 1050000, max_output_tokens: 1048576 },
      { id: 'eugeny-v6', owned_by: 'routing' }] }),
    'mantice', () => {});
  assert.equal(models.find((m) => m.id === 'eugeny-v6').contextWindow, DEFAULT_CONTEXT_WINDOW);
});

test('class derivation prefers gateway field then literals', () => {
  assert.equal(classOf({ id: 'whatever', class: 'fast' }), 'fast');
  assert.equal(classOf({ id: 'fornace-max' }), 'max');
  assert.equal(classOf({ id: 'max' }), 'max');
  assert.equal(classOf({ id: 'aliasish', owned_by: 'alias:fornace-reasoning' }), 'reasoning');
  assert.equal(classOf({ id: 'glm-custom' }), null);
});

test('compaction chain resolves alias ids in order', () => {
  const ids = compactionModelIds(capabilityRows, COMPACTION_CHAIN);
  assert.deepEqual(ids, ['flash']); // no fast-class row in fixture
  const complete = capabilityRows.concat([{ id: 'fornace-fast', owned_by: 'routing', context_window: 400000, max_output_tokens: 128000, mode: 'chat', class: 'fast' }]);
  assert.deepEqual(compactionModelIds(complete, COMPACTION_CHAIN), ['flash', 'fornace-fast']);
});
