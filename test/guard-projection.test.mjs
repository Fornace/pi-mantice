import test from 'node:test';
import assert from 'node:assert';
import {
  compactRequest, estimate, explainStalledReduction, IRREDUCIBLE,
} from '../src/guard-projection.ts';

const text = (role, timestamp, body) => ({ role, timestamp, content: [{ type: 'text', text: body }] });
const call = (timestamp, id, name) => ({
  role: 'assistant', timestamp, content: [{ type: 'toolCall', id, name, arguments: {} }],
});
const result = (timestamp, id, name, body, details) => ({
  role: 'toolResult', timestamp, toolCallId: id, toolName: name, isError: false,
  content: [{ type: 'text', text: body }], ...(details ? { details } : {}),
});

test('tool result details are local render state and never count against the request', () => {
  const png = 'A'.repeat(716_624); // the base64 of a 537KB image, as pi-banana used to attach
  const plain = { messages: [result(1, 'c1', 'banana_image', 'Generated → assets/banner.png')] };
  const withDetails = {
    messages: [result(1, 'c1', 'banana_image', 'Generated → assets/banner.png',
      { outputPath: 'assets/banner.png', mimeType: 'image/png', imageBase64: png })],
  };
  assert.ok(estimate(plain) < 100, `${estimate(plain)} tokens for one text line`);
  assert.ok(estimate(withDetails) - estimate(plain) < 100,
    `details added ${estimate(withDetails) - estimate(plain)} tokens to the estimate`);
});

test('a stalled reduction names the message that blocked it and rules out retry', () => {
  const reduced = {
    systemPrompt: 'short',
    messages: [
      text('user', 1, 'digest'),
      call(2, 'c1', 'read'),
      result(3, 'c1', 'read', 'x'.repeat(800_000)),
    ],
  };
  const after = estimate(reduced);
  const { reason, recovery } = explainStalledReduction({ reduced, estimated: 232_770, after, limit: 200_000 });
  assert.match(reason, /read tool result/);
  assert.match(reason, /still over the 200,000 limit/);
  assert.match(reason, new RegExp(String(after).replace(/\B(?=(\d{3})+(?!\d))/g, ',')));
  assert.match(recovery, /\/tree/);
  assert.match(recovery, /retry keeps it/);
});

test('a stalled reduction blames tool schemas when the schemas are the weight', () => {
  const reduced = {
    systemPrompt: 'y'.repeat(400_000),
    tools: [{ name: 'a', description: 'z'.repeat(400_000), parameters: {} }],
    messages: [text('user', 1, 'digest'), text('assistant', 2, 'ok')],
  };
  const after = estimate(reduced);
  const { reason, recovery } = explainStalledReduction({ reduced, estimated: after, after, limit: 200_000 });
  assert.match(reason, /system prompt and 1 tool schemas/);
  assert.match(reason, /before any history/);
  assert.match(recovery, /fewer tools/);
});

test('a reduction that freed almost nothing reports the percentage, not the limit', () => {
  const reduced = { messages: Array.from({ length: 40 }, (_, i) => text('user', i, 'z'.repeat(400))) };
  const after = estimate(reduced);
  const { reason, recovery } = explainStalledReduction({ reduced, estimated: Math.round(after / 0.95), after, limit: 200_000 });
  assert.match(reason, /freed only 5%/);
  assert.match(reason, /40 retained messages/);
  assert.match(recovery, /\/tree/);
});

test('a request that is one indivisible tool batch says so instead of "insufficient progress"', () => {
  const context = { messages: [call(1, 'c1', 'read'), result(2, 'c1', 'read', 'x'.repeat(200_000))] };
  assert.throws(() => compactRequest(context), new RegExp(IRREDUCIBLE));
});
