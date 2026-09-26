import test from 'node:test';
import assert from 'node:assert';
import { capToolResults, limitToolResults, registerGuardRetirement, OVERSIZE_TOOL_RESULT_CHARS } from '../src/request-limits.ts';

const result = (text) => ({
  role: 'toolResult', timestamp: 1, toolCallId: 'c1', toolName: 'read', isError: false,
  content: [{ type: 'text', text }],
});
const system = { role: 'system', timestamp: 0, content: 'agent', toolsAdded: [{ name: 'bash', description: 'd', parameters: {} }] };

test('a request with nothing oversized goes out as the same object', () => {
  const context = { messages: [system, { role: 'user', timestamp: 1, content: 'hi' }, result('small')] };
  assert.equal(capToolResults(context), context);
});

test('an oversized tool result is capped in the request; everything else is untouched', async () => {
  const big = result('x'.repeat(OVERSIZE_TOOL_RESULT_CHARS + 50_000));
  const context = { messages: [system, { role: 'user', timestamp: 1, content: 'go' }, big] };
  let sent;
  const streams = limitToolResults({ stream: (m, c) => { sent = c; return []; }, streamSimple: () => [] });
  streams.stream({}, context, {});
  assert.equal(sent.messages[0], system);
  assert.equal(sent.messages[1], context.messages[1]);
  assert.equal(sent.messages[2].toolCallId, 'c1');
  assert.ok(sent.messages[2].content[0].text.length < 12_000);
  assert.match(sent.messages[2].content[0].text, /narrower offset\/limit/);
  assert.equal(big.content[0].text.length, OVERSIZE_TOOL_RESULT_CHARS + 50_000, 'the session copy is not mutated');
});

test('a stale paused guard record is closed as ready once; commands stay for the subagent preflight', () => {
  const handlers = {}; const commands = {}; const appended = []; const emitted = [];
  const api = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    registerCommand: (name, def) => { commands[name] = def; },
    appendEntry: (type, data) => appended.push({ type, data }),
    events: { emit: (name, data) => emitted.push({ name, data }) },
  };
  registerGuardRetirement(api);
  const branch = [{ type: 'custom', customType: 'mantice-spend-guard', data: { version: 1, state: 'paused', reason: 'x' } }];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 's1' } };
  handlers.session_start[0]({}, ctx);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.state, 'ready');
  assert.equal(emitted[0].data.sessionId, 's1');
  branch.push({ type: 'custom', customType: 'mantice-spend-guard', data: appended[0].data });
  handlers.session_start[0]({}, ctx);
  assert.equal(appended.length, 1, 'a ready record is left alone');
  assert.ok(commands['mantice-guard'] && commands['mantice-child-budget']);
});
