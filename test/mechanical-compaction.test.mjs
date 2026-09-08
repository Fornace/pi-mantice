import test from 'node:test';
import assert from 'node:assert';
import {
  buildMechanicalDigest, DIGEST_BUDGET_BYTES, fileListsOf, MECHANICAL_DIGEST_VERSION,
} from '../src/mechanical-compaction.ts';
import { pruneSummaryToolResults } from '../src/summary-pruning.ts';

function historyFixture() {
  const messages = [
    { role: 'user', timestamp: 1, content: 'old user message one' },
    { role: 'assistant', timestamp: 2, content: [
      { type: 'text', text: 'old assistant reply about payment flows' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/pay.ts' } },
    ] },
    { role: 'toolResult', timestamp: 3, toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'x'.repeat(5000) }] },
    { role: 'user', timestamp: 4, content: 'recent user message two' },
    { role: 'assistant', timestamp: 5, content: [{ type: 'text', text: 'recent reply' }] },
  ];
  return { messages, history: messages };
}

test('mechanical digest retains user text, strips tool payloads, stays under budget', () => {
  const { messages, history } = historyFixture();
  const pruned = pruneSummaryToolResults(messages, history);
  const digest = buildMechanicalDigest({
    messages: pruned.messages,
    readFiles: ['src/pay.ts'],
    modifiedFiles: ['src/flows.ts'],
  });
  assert.ok(digest.bytes <= DIGEST_BUDGET_BYTES);
  assert.ok(digest.summary.includes('old user message one'));
  assert.ok(digest.summary.includes('recent user message two'));
  assert.ok(!digest.summary.includes('xxxxx')); // 5000-byte tool payload gone
  assert.ok(digest.summary.includes('src/pay.ts'));
  assert.ok(digest.summary.includes('src/flows.ts'));
  assert.ok(digest.summary.includes(MECHANICAL_DIGEST_VERSION));
  assert.equal(digest.userMessages, 2);
  assert.ok(digest.toolCalls >= 1);
});

test('progressive user caps shrink a huge digest to the budget', () => {
  const big = Array.from({ length: 300 }, (_, i) => ({
    role: 'user', timestamp: i, content: `message ${i} ` + 'y'.repeat(4000),
  }));
  const digest = buildMechanicalDigest({ messages: big, readFiles: [], modifiedFiles: [] });
  assert.ok(digest.bytes <= DIGEST_BUDGET_BYTES, `digest ${digest.bytes} exceeded budget`);
  assert.equal(digest.cappedUserBytes, 128);
  assert.ok(digest.summary.includes('message 0'));
  assert.ok(digest.summary.includes('message 299'));
});

test('previous summary and focus are carried, budget never exceeded', () => {
  const { messages, history } = historyFixture();
  const pruned = pruneSummaryToolResults(messages, history);
  const digest = buildMechanicalDigest({
    messages: pruned.messages,
    previousSummary: 'previous summary text about the payme goal',
    focus: 'keep payment incident details',
  }, 20_000);
  assert.ok(digest.bytes <= 20_000);
  assert.ok(digest.summary.includes('previous summary text'));
  assert.ok(digest.summary.includes('payment incident details'));
});

test('fileListsOf separates read and modified files', () => {
  const lists = fileListsOf({
    read: new Set(['a.ts', 'b.ts']),
    written: new Set(['c.ts']),
    edited: new Set(['d.ts', 'c.ts']),
  });
  assert.deepEqual(lists, { readFiles: ['a.ts', 'b.ts'], modifiedFiles: ['c.ts', 'd.ts'] });
});
