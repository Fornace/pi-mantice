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

test('stale or changed checkpoint prefix auto-invalidates without pausing the session', async () => {
  const entries = [{ type: 'message', message: usage(10_000) }];
  const handlers = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'prefix-change', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: () => {}, on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: () => {},
  };
  const guard = registerSpendGuard(api);

  // Set an existing checkpoint with a mismatched prefixHash
  const staleCheckpoint = {
    count: 2,
    prefixHash: 'mismatched-hash',
    summary: 'old digest',
    summaryHash: 'also-mismatched',
    at: Date.now() - 60_000,
  };
  const branchWithCp = [
    { type: 'custom', customType: 'mantice-spend-guard', data: { version: 1, state: 'ready', reason: 'previous', at: 1, checkpoint: staleCheckpoint } },
  ];
  const ctxWithCp = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => branchWithCp } };
  handlers.session_start[0]({}, ctxWithCp);

  const context = {
    messages: [
      { role: 'user', timestamp: 1, content: 'hello' },
      { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', timestamp: 3, content: 'continue' },
    ],
  };
  let executed = false;
  const wrapped = {
    stream: (model, ctx2, options) => guard.wrap({
      stream: async function* () { executed = true; yield { type: 'done', message: usage(1) }; },
    }).stream(model, ctx2, options),
  };

  for await (const event of wrapped.stream({ contextWindow: 200_000, provider: 'mantice' }, context, {})) {
    if (event.type === 'error') throw new Error(event.errorMessage);
  }
  assert.ok(executed, 'request ran despite stale checkpoint prefix');
});

test('interrupted tool call in retained history does not crash compaction or pause session', async () => {
  const entries = [{ type: 'message', message: usage(10_000) }];
  const handlers = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'interrupted-call', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: () => {}, on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: () => {},
  };
  const guard = registerSpendGuard(api);
  handlers.session_start[0]({}, ctx);

  // Assistant called a tool, user interrupted (sent text before tool result)
  const context = {
    messages: [
      { role: 'user', timestamp: 1, content: 'run tool' },
      { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', id: 'c_abandoned', name: 'bash', arguments: { command: 'sleep 300' } }] },
      { role: 'user', timestamp: 3, content: 'still training?' },
    ],
  };
  let executed = false;
  const wrapped = {
    stream: (model, ctx2, options) => guard.wrap({
      stream: async function* () { executed = true; yield { type: 'done', message: usage(1) }; },
    }).stream(model, ctx2, options),
  };

  for await (const event of wrapped.stream({ contextWindow: 1_100_000, provider: 'mantice' }, context, {})) {
    if (event.type === 'error') throw new Error(event.errorMessage);
  }
  assert.ok(executed, 'session ran despite interrupted tool call in history');
});

test('stalled reduction on request fitting model context window admits unreduced without pausing', async () => {
  const entries = [{ type: 'message', message: usage(10_000) }];
  const notifications = [];
  const handlers = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'model-headroom', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: (msg, level) => notifications.push({ msg, level }) },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: () => {}, on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: () => {},
  };
  const guard = registerSpendGuard(api);
  handlers.session_start[0]({}, ctx);

  // Request exceeds the 200K soft limit but easily fits a 1.1M model window
  const context = {
    messages: [
      { role: 'user', timestamp: 1, content: 'x'.repeat(400_000) },
      { role: 'user', timestamp: 2, content: 'x'.repeat(450_000) },
    ],
  };
  let executed = false;
  const wrapped = {
    stream: (model, ctx2, options) => guard.wrap({
      stream: async function* () { executed = true; yield { type: 'done', message: usage(1) }; },
    }).stream(model, ctx2, options),
  };

  for await (const event of wrapped.stream({ contextWindow: 1_100_000, provider: 'mantice' }, context, {})) {
    if (event.type === 'error') throw new Error(event.errorMessage);
  }
  assert.ok(executed, 'request ran under model headroom without pausing');
});

test('high cacheRead usage does not trigger token rate compaction', async () => {
  const recentTime = Date.now() - 60_000;
  // 30 messages with 80k cacheRead each = 2.4M cacheRead tokens, but only 100 input tokens each
  const entries = Array.from({ length: 30 }, () => ({
    type: 'message',
    message: {
      role: 'assistant',
      timestamp: recentTime,
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 100, output: 50, cacheRead: 80_000, cacheWrite: 0 },
      stopReason: 'stop',
    },
  }));
  const emitted = [];
  const handlers = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'cache-read-rate', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: (event, data) => emitted.push({ event, data }), on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: () => {},
  };
  const guard = registerSpendGuard(api);
  handlers.session_start[0]({}, ctx);

  const context = {
    messages: [
      { role: 'user', timestamp: 1, content: 'hello' },
      { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', timestamp: 3, content: 'next' },
    ],
  };
  let executed = false;
  const wrapped = {
    stream: (model, ctx2, options) => guard.wrap({
      stream: async function* () { executed = true; yield { type: 'done', message: usage(1) }; },
    }).stream(model, ctx2, options),
  };

  for await (const event of wrapped.stream({ contextWindow: 200_000, provider: 'mantice' }, context, {})) {
    if (event.type === 'error') throw new Error(event.errorMessage);
  }
  assert.ok(executed, 'request ran');
  assert.ok(!emitted.some(e => e.data?.state === 'compacting'), 'guard must not trigger compaction on cache reads');
});

test('high uncached throughput usage does trigger token rate compaction', async () => {
  const recentTime = Date.now() - 60_000;
  // 25 messages with 90k uncached input each = 2.25M uncached tokens in 1 minute
  const entries = Array.from({ length: 25 }, () => ({
    type: 'message',
    message: {
      role: 'assistant',
      timestamp: recentTime,
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 90_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'stop',
    },
  }));
  const emitted = [];
  const handlers = {};
  const ctx = {
    sessionManager: { getSessionId: () => 'uncached-rate', getBranch: () => entries, getEntries: () => entries },
    ui: { notify: () => {} },
  };
  const api = {
    appendEntry: () => {},
    events: { emit: (event, data) => emitted.push({ event, data }), on: () => {} },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerCommand: () => {},
  };
  const guard = registerSpendGuard(api);
  handlers.session_start[0]({}, ctx);

  const context = {
    messages: [
      { role: 'user', timestamp: 1, content: 'a'.repeat(200_000) },
      { role: 'user', timestamp: 2, content: 'b'.repeat(200_000) },
    ],
  };
  let executed = false;
  const wrapped = {
    stream: (model, ctx2, options) => guard.wrap({
      stream: async function* () { executed = true; yield { type: 'done', message: usage(1) }; },
    }).stream(model, ctx2, options),
  };

  for await (const event of wrapped.stream({ contextWindow: 1_000_000, provider: 'mantice' }, context, {})) {
    if (event.type === 'error') throw new Error(event.errorMessage);
  }
  assert.ok(executed, 'request ran');
  assert.ok(emitted.some(e => e.data?.reason?.includes('token rate soft threshold')),
    'guard must trigger rate compaction on high uncached throughput');
});
