import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewaySessionIdentity, registerSessionIdentity, SESSION_HEADER } from '../src/session-identity.ts';

function hook() {
  let callback;
  registerSessionIdentity({ on(name, handler) {
    assert.equal(name, 'before_provider_headers');
    callback = handler;
  } });
  return callback;
}

function context(provider, id) {
  return { model: provider ? { provider } : undefined,
    sessionManager: { getSessionId: () => id } };
}

test('identity is opaque, bounded, stable across reload, and distinct per session', () => {
  const first = gatewaySessionIdentity('session-a');
  assert.equal(first, gatewaySessionIdentity('session-a'));
  assert.notEqual(first, gatewaySessionIdentity('session-b'));
  assert.match(first, /^pi-[a-f0-9]{64}$/);
  assert.ok(!first.includes('session-a'));
  assert.equal(gatewaySessionIdentity(''), undefined);
});

test('both gateway provider aliases get the current session identity', () => {
  const handler = hook();
  for (const provider of ['mantice', 'fornace']) {
    const headers = { authorization: 'fixture-token', 'prompt-cache-key': 'unchanged' };
    handler({ headers }, context(provider, 'session-a'));
    assert.equal(headers[SESSION_HEADER], gatewaySessionIdentity('session-a'));
    assert.equal(headers.authorization, 'fixture-token');
    assert.equal(headers['prompt-cache-key'], 'unchanged');
  }
});

test('switching sessions does not retain a closure-captured identity', () => {
  const handler = hook();
  const headers = {};
  handler({ headers }, context('mantice', 'session-a'));
  handler({ headers }, context('mantice', 'session-b'));
  assert.equal(headers[SESSION_HEADER], gatewaySessionIdentity('session-b'));
  const resumed = {};
  hook()({ headers: resumed }, context('mantice', 'session-a'));
  assert.equal(resumed[SESSION_HEADER], gatewaySessionIdentity('session-a'));
});

test('case variants collapse without changing unrelated or cache headers', () => {
  const headers = { 'x-mantice-session-id': 'old', 'X-MANTICE-SESSION-ID': 'other',
    'x-session-id': 'cache-affinity', 'x-request-id': 'request' };
  hook()({ headers }, context('mantice', 'session-a'));
  assert.deepEqual(headers, { 'x-session-id': 'cache-affinity', 'x-request-id': 'request',
    [SESSION_HEADER]: gatewaySessionIdentity('session-a') });
});

test('missing identity removes a stale gateway header without inventing a session', () => {
  const headers = { 'x-mantice-session-id': 'stale' };
  hook()({ headers }, context('mantice', ''));
  assert.deepEqual(headers, {});
});

test('other providers and absent models remain untouched', () => {
  for (const provider of ['openai', 'anthropic', undefined]) {
    const headers = { 'x-session-id': 'existing' };
    hook()({ headers }, context(provider, 'session-a'));
    assert.deepEqual(headers, { 'x-session-id': 'existing' });
  }
});
