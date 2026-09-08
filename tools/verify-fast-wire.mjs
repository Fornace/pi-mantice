// Real Pi RPC fixture for the two-stage fast compaction.
// Loopback provider only: /fast session must make ZERO model calls; /compact
// (Pi native) must make exactly one call whose payload proves pruning ran.
// The fast_read RTK tool is exercised end to end through a tool-calling turn.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'pi-mantice-fast-wire-'));
const calls = [];

const LONG = ('The payment timer incident kept evolving through overlapping entries and ' +
  'backfill corrections. '.repeat(90));

function sse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: ['fornace-max', 'fornace-fast'].map(id => ({
      id, owned_by: 'routing', context_window: 1100000, max_output_tokens: 16384,
      mode: 'chat', class: id === 'fornace-max' ? 'max' : 'fast',
    })) }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end(); return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const wire = JSON.stringify(body);
  calls.push({ model: body.model, wire, hasToolResults: wire.includes('tool_call_id') });
  const wantsTools = Array.isArray(body.tools) && wire.includes('TOOLSNOW')
    && calls.filter(c => c.wire.includes('TOOLSNOW')).length === 1;
  if (wantsTools) {
    sse(response, [
      { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-fastread', type: 'function',
          function: { name: 'fast_read', arguments: JSON.stringify({ path: 'sample.ts', level: 'aggressive' }) } }] } }] },
      { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ]);
    return;
  }
  if (body.messages?.some(m => Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result'))
    || body.messages?.some(m => m.role === 'tool')) {
    sse(response, [
      { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'tool round complete' } }] },
      { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ]);
    return;
  }
  sse(response, [
    { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: LONG } }] },
    { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 500, completion_tokens: 900, total_tokens: 1400 } },
  ]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

await writeFile(join(root, 'sample.ts'), [
  'export function payTimer(entry: Entry): Result {',
  '  const overlap = entries.find(other => overlaps(other, entry));',
  '  if (overlap) return err(`overlaps existing entry ${overlap.id}`);',
  '  return ok(persist(entry));',
  '}',
  'export function backfill(range: Range): Result {',
  '  return ok(range.entries.map(payTimer));',
  '}',
].join('\n'));
const agentDir = join(root, 'agent');
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
  quietStartup: true, defaultProvider: 'mantice', defaultModel: 'fornace-max',
  compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
}));

const events = [];
const pi = spawn(process.env.PI_TEST_BIN || 'pi', [
  '--offline', '--no-extensions', '--extension', join(repo, 'extensions/mantice-models.ts'),
  '--no-skills', '--no-themes', '--no-prompt-templates', '--no-context-files',
  '--provider', 'mantice', '--model', 'fornace-max', '--thinking', 'off',
  '--session-dir', join(root, 'sessions'), '--mode', 'rpc', '--no-session',
], {
  cwd: root,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0', NO_COLOR: '1',
    MANTICE_BASE_URL: `http://127.0.0.1:${port}/v1`, MANTICE_API_KEY: 'local-fixture-token',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
pi.stderr.on('data', bytes => { stderr += bytes; });
const done = new Promise(resolve => pi.stdout.on('end', resolve));
const reader = (async () => {
  let buffer = '';
  for await (const chunk of pi.stdout) {
    buffer += chunk;
    for (const line of buffer.split('\n')) {
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* partial */ } }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  }
})();

const wait_for = async (check, timeout, label) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = events.find(check);
    if (found) return found;
    if (pi.exitCode !== null) throw new Error(`pi exited (${pi.exitCode}) before ${label}: ${stderr.slice(-800)}`);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}; stderr: ${stderr.slice(-800)}; ` +
    `events: ${JSON.stringify(events.slice(-12).map(e => ({ t: e.type, tool: e.toolName, err: e.error })))}; ` +
    `calls: ${JSON.stringify(calls.map(c => ({ model: c.model, bytes: c.wire.length, tools: c.wire.includes('fast_read') })))}`);
};
const send = command => { pi.stdin.write(JSON.stringify(command) + '\n'); };
let settled = 0;
const nextSettled = async label => {
  await wait_for(e => e.type === 'agent_settled' && events.indexOf(e) >= settled, 60000, label);
  settled = events.length;
};

try {
  send({ type: 'prompt', message: 'turn one: payments timer overlap discussion' });
  await nextSettled('first turn settled');
  send({ type: 'prompt', message: 'turn two: backfill corrections' });
  await nextSettled('second turn settled');
  send({ type: 'prompt', message: 'TOOLSNOW read the sample file' });
  await nextSettled('tool turn settled');
  const toolEvents = events.filter(e => e.type.startsWith('tool_')).map(e => ({ t: e.type, tool: e.toolName, args: e.args ?? e.input, err: e.error, result: e.result && String(JSON.stringify(e.result)).slice(0, 200) }));
  const lastMessages = events.filter(e => e.type === 'message_end').map(e => JSON.stringify(e.message).slice(0, 300));
  assert.ok(toolEvents.some(e => e.tool === 'fast_read' && e.t === 'tool_execution_start'),
    `fast_read tool was never executed; tool events: ${JSON.stringify(toolEvents)}; ` +
    `messages: ${lastMessages.join(' || ')}; calls: ${calls.length} last wire: ${(calls.at(-1)?.wire ?? '').slice(0, 600)}`);
  assert.ok(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'fast_read'), 'fast_read never finished');

  // Stage 2 first: Pi native /compact on pruned input, exactly one model call.
  calls.length = 0;
  send({ type: 'compact' });
  const native = await wait_for(e => e.type === 'compaction_end', 60000, 'native compaction_end');
  if (calls.length < 1) {
    const end = events.filter(e => e.type.startsWith('compaction')).map(e => JSON.stringify(e).slice(0, 400));
    throw new Error(`native compaction made ${calls.length} calls; compaction events: ${end.join(' || ')}`);
  }
  assert.ok(calls.every(call => call.model === 'fornace-max'), 'native compaction did not use the session model');
  // A split turn makes Pi summarize history plus the turn prefix separately.
  assert.ok(calls.some(call => call.wire.includes('stripped')),
    'pruning markers missing from native summarizer request');
  const nativeSummary = (native.result ?? {}).summary ?? '';
  assert.ok(!nativeSummary.includes('Mechanical context digest'), 'native compaction unexpectedly used the mechanical digest');

  // Two fresh turns, then stage 1: /fast session makes zero model calls.
  send({ type: 'prompt', message: 'turn three: quota budget fix' });
  await nextSettled('third turn settled');
  send({ type: 'prompt', message: 'turn four: session failover notes' });
  await nextSettled('fourth turn settled');
  calls.length = 0;
  send({ type: 'prompt', message: '/fast session payment incident focus' });
  const mechanical = await wait_for(e => e.type === 'compaction_end'
    && String(e.result?.summary ?? '').startsWith('Mechanical context digest'), 60000, 'mechanical compaction_end');
  assert.equal(calls.length, 0, `/fast session made ${calls.length} model calls, expected 0`);
  const result = mechanical.result ?? {};
  assert.ok(String(result.summary).startsWith('Mechanical context digest'),
    `mechanical digest missing; compactions: ${JSON.stringify(events.filter(e => e.type.startsWith('compaction')).map(e => ({ t: e.type, reason: e.reason, err: e.errorMessage, head: String(e.result?.summary ?? '').slice(0, 80) })))} result: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(String(result.summary).includes('turn three: quota budget fix'), 'user message lost from digest');
  assert.ok(String(result.summary).includes('turn four: session failover notes'), 'user message lost from digest');
  assert.ok(String(result.summary).includes('payment incident focus'), 'focus instruction lost from digest');
  assert.equal(result.usage, undefined, 'mechanical compaction must not record LLM usage');
  assert.deepEqual(result.details && { mechanical: result.details.mechanical },
    { mechanical: true }, 'mechanical details flag missing');
  assert.ok(!pi.killed);
  console.log('PASS: /fast session compacted mechanically with zero model calls; /compact ran Pi native on pruned input; fast_read executed via RTK');
} finally {
  pi.kill('SIGKILL');
  await Promise.race([done, new Promise(r => setTimeout(r, 3000))]);
  reader.catch(() => {});
  server.close();
  await rm(root, { recursive: true, force: true });
}
