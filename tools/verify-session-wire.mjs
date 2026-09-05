// Real Pi CLI -> loopback HTTP fixture. No live provider or installed extension edits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewaySessionIdentity } from '../src/session-identity.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'pi-mantice-session-wire-'));
const calls = [];
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: ['fornace-max', 'fornace-fast'].map(id => ({
      id, context_window: 1100000, max_output_tokens: 16384,
    })) }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  calls.push({ headers: request.headers, rawHeaders: request.rawHeaders, body });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    { id: 'fixture', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture OK' }, finish_reason: null }] },
    { id: 'fixture', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ];
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

async function turn(id) {
  const child = spawn(process.env.PI_TEST_BIN || 'pi', [
    '--offline', '--no-extensions', '--extension', join(repo, 'extensions/mantice-models.ts'),
    '--no-skills', '--no-themes', '--no-prompt-templates', '--no-context-files', '--no-tools',
    '--provider', 'mantice', '--model', 'fornace-fast', '--thinking', 'off',
    '--session-dir', join(root, 'sessions'), '--session-id', id,
    '--system-prompt', 'Local synthetic fixture. Respond briefly.',
    '--print', 'synthetic session identity fixture',
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: join(root, 'config'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
      MANTICE_BASE_URL: `http://127.0.0.1:${port}/v1`, MANTICE_API_KEY: 'local-fixture-token',
      FORNACE_LLM_API_KEY: 'local-fixture-token', NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-6000); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-6000); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, output);
    assert.ok(output.includes('fixture OK'), output);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  for (const id of [a, a, b]) await turn(id);
  assert.equal(calls.length, 3);
  for (const [index, id] of [a, a, b].entries()) {
    const { headers, rawHeaders, body } = calls[index];
    assert.equal(headers['x-mantice-session-id'], gatewaySessionIdentity(id));
    assert.equal(rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === 'x-mantice-session-id').length, 1);
    assert.equal(headers.authorization, 'Bearer local-fixture-token');
    assert.ok(JSON.stringify(body.messages).includes('synthetic session identity fixture'));
  }
  console.log('session-wire: PASS; real Pi CLI sends one stable header across resume, isolates new sessions, preserves prompt and authorization');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
