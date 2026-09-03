import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOverflowMessage, createResponseModelWatcher } from '../src/overflow.ts';

const PROVIDERS = ['mantice', 'fornace'];

test('upstream overflow wordings become canonical for Pi recovery', () => {
  const cases = [
    'prompt is too long: 362214 tokens > 262144 maximum',
    'This endpoint\'s maximum context length is 262144 tokens.',
    'Input length (362214) exceeds the maximum context length of 262144 tokens.',
    'Input length exceeds model maximum context length of 262144 tokens.',
    '400: {"code":"1261","message":"Prompt exceeds max length"}',
  ];
  for (const errorMessage of cases) {
    const rewritten = canonicalOverflowMessage(
      { role: 'assistant', stopReason: 'error', provider: 'mantice', errorMessage }, PROVIDERS);
    assert.match(rewritten, /^context_length_exceeded: /, errorMessage);
  }
});

test('already canonical, rate limits, and route availability are never rewritten', () => {
  const keep = [
    'context_length_exceeded: done already',
    'Upstream rate limit: 429 too many requests',
    '503: no healthy provider for fornace-max',
    '400 no_compatible_route: no route satisfies this request\'s tool requirements',
  ];
  for (const errorMessage of keep) {
    assert.equal(canonicalOverflowMessage(
      { role: 'assistant', stopReason: 'error', provider: 'mantice', errorMessage }, PROVIDERS), null);
  }
});

test('other providers and successes are untouched', () => {
  assert.equal(canonicalOverflowMessage(
    { role: 'assistant', stopReason: 'error', provider: 'google', errorMessage: 'prompt is too long' }, PROVIDERS), null);
  assert.equal(canonicalOverflowMessage(
    { role: 'assistant', stopReason: 'stop', provider: 'mantice', errorMessage: 'prompt is too long' }, PROVIDERS), null);
});

test('response model watcher notifies once per backend change per route', () => {
  const seen = [];
  const watcher = createResponseModelWatcher(PROVIDERS, (message) => seen.push(message));
  const base = { role: 'assistant', stopReason: 'toolUse', provider: 'mantice', model: 'fornace-max' };
  watcher({ ...base, responseModel: 'gpt-5.6-sol' });
  watcher({ ...base, responseModel: 'gpt-5.6-sol' });
  watcher({ ...base, responseModel: 'glm-5.3' });
  watcher({ ...base, responseModel: undefined });
  assert.equal(seen.length, 2);
  assert.match(seen[0], /fornace-max served by gpt-5.6-sol/);
  assert.match(seen[1], /fornace-max served by glm-5.3/);
});
