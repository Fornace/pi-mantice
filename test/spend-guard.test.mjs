import test from 'node:test';
import assert from 'node:assert';
import { registerSpendGuard } from '../src/spend-guard.ts';

const usage = (input) => ({
  role: 'assistant', timestamp: Date.now() - 60_000,
  content: [{ type: 'text', text: 'ok' }],
  usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 },
  stopReason: 'stop',
});

test('armed repair retry on a request that fits every threshold admits it instead of forcing a reduction', async () => {
  const entries = [{ type: 'message', message: usage(40_000) }];
  const handlers = {};
  const commands = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'retry-fits', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: () => {}, on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: (name, def) => { commands[name] = def; },
  };
  const guard = registerSpendGuard(api);
  handlers.session_start[0]({}, ctx);

  // The guard paused earlier (here: a false positive from the old estimator,
  // which counted a 717K-char imageBase64 inside tool-result details). The
  // human repaired the cause and ran /mantice-guard retry. The same request
  // now fits every threshold, so the retry must admit it: forcing a verified
  // reduction anyway dead-ends on the newest tool batch (IRREDUCIBLE) and
  // re-pauses a session that has nothing left to repair.
  await commands['mantice-guard'].handler('retry', ctx);
  const done = { type: 'done', message: usage(1) };
  const streams = { stream: async function* () { yield done; } };
  const imageDetails = {
    role: 'toolResult', timestamp: Date.now() - 3_600_000, toolCallId: 'c1', toolName: 'banana_image',
    content: [{ type: 'text', text: 'Generated → assets/banner.png' }],
    details: { imageBase64: 'A'.repeat(717_656) },
  };
  const context = {
    systemPrompt: 'agent',
    messages: [{ role: 'user', timestamp: 1, content: 'resume' }, imageDetails],
  };
  await (async () => {
    for await (const event of guard.wrap(streams).stream({ contextWindow: 200_000, provider: 'mantice' }, context, {})) {
      if (event.type === 'error') throw new Error(event.errorMessage);
    }
  })();
  assert.equal(commands['mantice-guard'], commands['mantice-guard']);
});

test('armed repair retry still compacts a request that exceeds the context limit', async () => {
  const entries = [{ type: 'message', message: usage(10_000) }];
  const handlers = {};
  const commands = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'retry-over', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: () => {}, on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: (name, def) => { commands[name] = def; },
  };
  const guard = registerSpendGuard(api);
  handlers.session_start[0]({}, ctx);
  await commands['mantice-guard'].handler('retry', ctx);
  const context = {
    messages: [
      { role: 'user', timestamp: 1, content: 'a'.repeat(300_000) },
      { role: 'user', timestamp: 2, content: 'b'.repeat(300_000) },
      { role: 'user', timestamp: 3, content: 'c'.repeat(300_000) },
      { role: 'user', timestamp: 4, content: 'go' },
    ],
  };
  const streams = { stream: async function* () { yield { type: 'done', message: usage(1) }; } };
  let projectedMessages = 0;
  const wrapped = {
    stream: (model, ctx2, options) => guard.wrap({
      stream: async function* (m, c) { projectedMessages = c.messages.length; yield { type: 'done', message: usage(1) }; },
    }).stream(model, ctx2, options),
  };
  await (async () => {
    for await (const event of wrapped.stream({ contextWindow: 200_000, provider: 'mantice' }, context, {})) {
      if (event.type === 'error') throw new Error(event.errorMessage);
    }
  })();
  assert.ok(projectedMessages < context.messages.length,
    `reduction kept all ${projectedMessages} messages`);
});
