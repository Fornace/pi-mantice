// Real ModelRegistry.complete transport, isolated state, synthetic loopback only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { compactWithClassChain } from '../src/summarize.ts';
import { gatewaySessionIdentity } from '../src/session-identity.ts';

const root = await mkdtemp(join(tmpdir(), 'pi-compaction-wire-'));
const calls = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  calls.push({ headers: req.headers, rawHeaders: req.rawHeaders,
    body: JSON.parse(Buffer.concat(chunks)) });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = { id: 'fixture', object: 'chat.completion.chunk', model: 'fornace-fast',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic summary' }, finish_reason: 'stop' }] };
  res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const runtime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models.json'), refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider('mantice', {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    api: 'openai-completions', apiKey: 'fixture-token',
    models: [{ id: 'fornace-fast', name: 'Fixture', reasoning: false,
      input: ['text'], contextWindow: 1100000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false } }],
  });
  const registry = new ModelRegistry(runtime);
  for (const conversationId of ['session-a', 'session-a', 'session-b']) {
    const result = await compactWithClassChain({ reason: 'threshold',
      signal: AbortSignal.timeout(10000), preparation: {
        messagesToSummarize: [{ role: 'user', content: 'Preserve synthetic context' }],
        turnPrefixMessages: [], previousSummary: null,
        firstKeptEntryId: 'entry', tokensBefore: 100000,
      },
    }, {
      chain: ['fast'], modelIds: ['fornace-fast'], conversationId,
      newSessionId: () => `cache-${calls.length}`,
      resolveModel: id => registry.find('mantice', id), notify: () => {},
      complete: async (model, context, options) => {
        assert.equal(options.cacheRetention, 'none');
        const response = await registry.complete(model, context, {
          ...options, apiKey: 'fixture-token', maxRetries: 0,
        });
        return { text: response.content.filter(block => block.type === 'text').map(block => block.text).join('') };
      },
    }, JSON.stringify);
    assert.equal(result?.compaction?.summary, 'Synthetic summary');
  }
  assert.equal(calls.length, 3);
  for (const [index, id] of ['session-a', 'session-a', 'session-b'].entries()) {
    const { headers, rawHeaders, body } = calls[index];
    assert.equal(headers['x-mantice-session-id'], gatewaySessionIdentity(id));
    assert.equal(headers.authorization, 'Bearer fixture-token');
    assert.equal(rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === 'x-mantice-session-id').length, 1);
    assert.equal(body.prompt_cache_key, undefined);
    assert.ok(JSON.stringify(body.messages).includes('Preserve synthetic context'));
  }
  console.log('compaction-wire: PASS; real ModelRegistry.complete, cache none, stable scoped header, prompt/auth preserved');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
