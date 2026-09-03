import test from 'node:test';
import assert from 'node:assert/strict';
import { compactWithClassChain, summaryPrompt } from '../src/summarize.ts';

function event(reason = 'threshold', overrides = {}) {
  return {
    reason,
    signal: new AbortController().signal,
    preparation: {
      messagesToSummarize: [{ role: 'user' }],
      turnPrefixMessages: [],
      previousSummary: null,
      tokensBefore: 100000,
      firstKeptEntryId: 'keep-1',
      ...overrides,
    },
  };
}

function deps(behavior) {
  const notifications = [];
  return {
    notifications,
    value: {
      chain: ['flash', 'fast'],
      modelIds: ['flash', 'fornace-fast'],
      resolveModel: (id) => (behavior.missing?.includes(id) ? null : { id }),
      complete: async (model) => behavior(model),
      newSessionId: () => 'session-1',
      notify: (message) => notifications.push(message),
    },
  };
}

const serialize = (messages) => JSON.stringify(messages);

test('empty span skips custom compaction entirely', async () => {
  const { value } = deps(() => { throw new Error('must not call'); });
  const result = await compactWithClassChain(
    event('threshold', { messagesToSummarize: [] }), value, serialize);
  assert.equal(result, undefined);
});

test('first class route success returns compaction with usage', async () => {
  const { value, notifications } = deps((model) => ({ text: `summary for ${model.id}`, usage: { totalTokens: 7 } }));
  const result = await compactWithClassChain(event(), value, serialize);
  assert.equal(result.compaction.summary, 'summary for flash');
  assert.equal(result.compaction.firstKeptEntryId, 'keep-1');
  assert.deepEqual(result.compaction.usage, { totalTokens: 7 });
  assert.equal(notifications.length, 0);
});

test('flash failure falls to fast, notifying per failure', async () => {
  let calls = 0;
  const { value, notifications } = deps((model) => {
    calls += 1;
    if (model.id === 'flash') throw new Error('503 no healthy provider');
    return { text: 'from fast' };
  });
  const result = await compactWithClassChain(event(), value, serialize);
  assert.equal(calls, 2);
  assert.equal(result.compaction.summary, 'from fast');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /503 no healthy provider/);
});

test('all routes cancel on overflow trigger to avoid max-class summarization', async () => {
  const { value, notifications } = deps(() => { throw new Error('down'); });
  const result = await compactWithClassChain(event('overflow'), value, serialize);
  assert.deepEqual(result, { cancel: true });
  assert.match(notifications.at(-1), /cancelled/);
});

test('manual trigger falls through to Pi default instead of cancelling', async () => {
  const { value } = deps(() => { throw new Error('down'); });
  const result = await compactWithClassChain(event('manual'), value, serialize);
  assert.equal(result, undefined);
});

test('unresolvable model ids are skipped silently', async () => {
  const { value } = deps(() => ({ text: 'ok' }));
  value.modelIds = ['ghost', 'flash'];
  value.resolveModel = (id) => (id === 'ghost' ? null : { id });
  const result = await compactWithClassChain(event(), value, serialize);
  assert.equal(result.compaction.summary, 'ok');
});

test('summary prompt carries previous summary and section format', () => {
  const prompt = summaryPrompt('conversation text', 'previous notes');
  assert.match(prompt, /Previous session summary[\s\S]*previous notes/);
  assert.match(prompt, /## Key Decisions/);
  assert.match(prompt, /<conversation>\nconversation text\n<\/conversation>/);
});
