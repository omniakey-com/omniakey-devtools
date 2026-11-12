import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { checkKeyPolicy, fingerprint, toolsForScopes, validatePaidRequest } from './security';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ORIGIN = 'https://api.omniakey.com';
const API = 'https://api.omniakey.com';
const KEY = 'sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL';
const KEY2 = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv';
let ip: string;
const expectedFetches: { path: string; key: string; body: unknown; method: string; headers: Record<string, string>; status: number }[] = [];
function expectUpstream(path: string, key: string, body: unknown, method = 'GET', headers: Record<string, string> = {}, status = 200) {
  expectedFetches.push({ path, key, body, method, headers, status });
}

beforeEach(() => {
  ip = `192.0.2.${Math.floor(Math.random() * 240) + 1}`;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const expected = expectedFetches.shift();
    if (!expected) throw new Error('External network disabled; unexpected request');
    expect(request.url).toBe(`${API}${expected.path}`);
    expect(request.method).toBe(expected.method);
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('User-Agent')).toBe('OmniaKey-MCP/0.2.0 (+https://api.omniakey.com/mcp/)');
    expect(request.headers.get('Authorization')).toBe(`Bearer ${expected.key}`);
    for (const [name, value] of Object.entries(expected.headers)) expect(request.headers.get(name)).toBe(value);
    return Response.json(expected.body, { status: expected.status });
  }));
});
afterEach(async () => {
  const pending = expectedFetches.splice(0);
  vi.unstubAllGlobals();
  await reset();
  expect(pending).toEqual([]);
});

function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('CF-Connecting-IP', ip);
  return SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init, headers });
}
function jsonPost(path: string, body: unknown, extra: Record<string, string> = {}) {
  return req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
}
function cookie(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
function keyPolicy(key = KEY, response: Record<string, unknown> = {}) {
  expectUpstream('/v1/dashboard/billing/subscription', key, { object: 'billing_subscription', hard_limit_usd: 10, access_until: Math.floor(Date.now() / 1000) + 86400, ...response });
}
async function pendingConsent() {
  const registration = await jsonPost('/mcp/oauth/register', {
    client_name: 'Test assistant <script>alert(1)</script>',
    redirect_uris: ['https://client.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  });
  expect(registration.status).toBe(201);
  const client = await registration.json<{ client_id: string }>();
  const verifier = 'a'.repeat(43);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', resource: `${ORIGIN}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state' });
  const consent = await req(`/mcp/oauth/authorize?${query}`);
  expect(consent.status).toBe(200);
  expect(consent.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://client.example;");
  expect(consent.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  const page = await consent.text();
  expect(page).toContain('&lt;script&gt;');
  expect(page).not.toContain('<script>');
  const handle = page.match(/name="handle" value="([^"]+)"/)![1];
  return { client, verifier, handle, cookie: cookie(consent), query, page };
}
async function connect({ scopes = [], key = KEY, daily = 5 }: { scopes?: string[]; key?: string; daily?: number } = {}) {
  const consent = await pendingConsent();
  keyPolicy(key);
  const form = new URLSearchParams({ handle: consent.handle, decision: 'approve', api_key: key, daily_limit: String(daily), lifetime: '3600' });
  for (const scope of scopes) form.append('scope', scope);
  const approved = await req('/mcp/oauth/authorize', { method: 'POST', headers: { Origin: ORIGIN, Cookie: consent.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  expect(approved.status, (await approved.clone().text()).match(/<h1>[\s\S]*?<\/p>/)?.[0]).toBe(303);
  const redirect = new URL(approved.headers.get('Location')!);
  expect(redirect.origin).toBe('https://client.example');
  expect(redirect.toString()).not.toContain(key);
  const tokenForm = new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: consent.client.client_id, redirect_uri: 'https://client.example/callback', code_verifier: consent.verifier, resource: `${ORIGIN}/mcp` });
  const tokenResponse = await req('/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenForm.toString() });
  expect(tokenResponse.status).toBe(200);
  const tokens = await tokenResponse.json<{ access_token: string; refresh_token: string; scope: string }>();
  expect(JSON.stringify(tokens)).not.toContain(key);
  return { ...tokens, tokenForm, consent };
}
function rpc(token: string, method: string, params: unknown = {}) {
  return jsonPost('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' });
}

describe('public boundary', () => {
  it('requires authentication, never accepts keys in URLs/cookies, and pins its issuer', async () => {
    expect((await req('/mcp')).status).toBe(401);
    expect((await req('/mcp', { headers: { Cookie: `api_key=${KEY}` } })).status).toBe(401);
    expect((await req(`/mcp?api_key=${KEY}`)).status).toBe(400);
    expect((await req('/mcp', { headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(401);
    expect((await SELF.fetch('https://other.example/mcp')).status).toBe(404);
    expect((await req('/mcp', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const metadata = await req('/.well-known/oauth-protected-resource/mcp');
    expect(metadata.status).toBe(200);
    expect(await metadata.text()).toContain(`${ORIGIN}/mcp`);
    const page = await req('/mcp/');
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
  });

  it('publishes discovery for the API host and keeps unrelated paths outside MCP', async () => {
    const metadata = await (await req('/.well-known/oauth-authorization-server')).json<Record<string, unknown>>();
    expect(metadata.issuer).toBe(ORIGIN);
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}/mcp/oauth/authorize`);
    expect(metadata.token_endpoint).toBe(`${ORIGIN}/mcp/oauth/token`);
    expect(metadata.registration_endpoint).toBe(`${ORIGIN}/mcp/oauth/register`);
    for (const path of ['/', '/v1/models', '/api/provider/pricing', '/stripe/webhook', '/oauth/authorize', '/connections', '/mcp-other']) {
      expect((await req(path)).status).toBe(404);
    }
    expect((await SELF.fetch('https://mcp.omniakey.com/mcp')).status).toBe(404);
    expect((await req('/mcp/healthz')).status).toBe(200);
    const management = await req('/mcp/connections');
    expect(management.status).toBe(200);
    expect(management.headers.get('Set-Cookie')).toContain('__Host-omniakey-mcp-connections=');
    expect(await management.text()).toContain('action="/mcp/connections"');
  });

  it('blocks oversized bodies before OAuth handling', async () => {
    const response = await req('/mcp/oauth/register', { method: 'POST', body: 'x'.repeat(17000) });
    expect(response.status).toBe(413);
  });

  it('requires PKCE S256 and a browser-bound, same-origin, one-use consent', async () => {
    const consent = await pendingConsent();
    const form = new URLSearchParams({ handle: consent.handle, decision: 'approve', api_key: KEY, daily_limit: '5', lifetime: '3600' });
    expect((await req('/mcp/oauth/authorize', { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: consent.cookie }, body: form.toString() })).status).toBe(403);
    expect((await req('/mcp/oauth/authorize', { method: 'POST', headers: { Origin: ORIGIN }, body: form.toString() })).status).toBe(400);
    consent.query.delete('code_challenge');
    consent.query.delete('code_challenge_method');
    expect((await req(`/mcp/oauth/authorize?${consent.query}`)).status).toBe(400);
    expect(consent.page).not.toMatch(/value="omniakey:generate"[^>]*checked/);
  });
});

describe('credential and permission isolation', () => {
  it('encrypts the upstream key in KV and gives a read-only grant no paid tools', async () => {
    const auth = await connect();
    const response = await rpc(auth.access_token, 'tools/list');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map(t => t.name)).toEqual(['omniakey_models', 'omniakey_schema', 'omniakey_get_task', 'omniakey_wait_task']);
    const denied = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_chat', arguments: { request: { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } } });
    const denial = await denied.text();
    expect(denial).toMatch(/error|Unknown|not found/i);
    const keys = await env.OAUTH_KV.list();
    expect(keys.keys.length).toBeGreaterThan(0);
    for (const entry of keys.keys) expect(await env.OAUTH_KV.get(entry.name)).not.toContain(KEY);
  });

  it('supports a real Streamable HTTP client handshake and a read-only model call', async () => {
    const auth = await connect();
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${auth.access_token}`, 'CF-Connecting-IP': ip } },
      fetch: (input, init) => SELF.fetch(input, init),
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name)).toContain('omniakey_models');
      expectUpstream('/v1/models', KEY, { data: [{ id: 'verified-model' }] });
      const result = await client.callTool({ name: 'omniakey_models', arguments: {} });
      expect(JSON.stringify(result)).toContain('verified-model');
      expect(result.isError).not.toBe(true);
    } finally { await client.close(); }
  });

  it('refuses upstream redirects without forwarding the key to the new host', async () => {
    const auth = await connect();
    const mocked = vi.mocked(fetch);
    mocked.mockClear();
    mocked.mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://untrusted.example/' } }));
    const response = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_models', arguments: {} });
    expect(await response.text()).toContain('network_error');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(String(mocked.mock.calls[0][0])).toBe(`${API}/v1/models`);
  });

  it('uses only the individual caller key and never the MCP access token upstream', async () => {
    const a = await connect();
    const b = await connect({ key: KEY2 });
    for (const [auth, key, model] of [[a, KEY, 'model-a'], [b, KEY2, 'model-b']] as const) {
      expectUpstream('/v1/models', key, { data: [{ id: model }] });
      const response = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_models', arguments: {} });
      const text = await response.text();
      expect(text).toContain(model);
      expect(text).not.toContain(key);
      expect(text).not.toContain(auth.access_token);
    }
  });

  it('rejects unlimited, expired, and account-wide quota reports', () => {
    for (const report of [
      { object: 'billing_subscription', hard_limit_usd: 100000000, access_until: 9999999999 },
      { object: 'billing_subscription', hard_limit_usd: 10, access_until: 0 },
      { object: 'billing_subscription', hard_limit_usd: 10, access_until: 1 },
      { object: 'billing_subscription', hard_limit_usd: '10', access_until: 9999999999 },
    ]) expect(() => checkKeyPolicy(report)).toThrow();
    expect(toolsForScopes(['omniakey:cancel']).has('omniakey_chat')).toBe(false);
    expect(() => validatePaidRequest('/chat/completions', { max_tokens: 999999 })).toThrow();
    expect(() => validatePaidRequest('/chat/completions', {})).toThrow();
    expect(() => validatePaidRequest('/media/tasks', { parameters: { n: 20 } })).toThrow();
  });

  it('rejects an unlimited key during the complete authorization flow', async () => {
    const consent = await pendingConsent();
    keyPolicy(KEY, { hard_limit_usd: 100000000 });
    const form = new URLSearchParams({ handle: consent.handle, decision: 'approve', api_key: KEY, daily_limit: '5', lifetime: '3600' });
    const response = await req('/mcp/oauth/authorize', { method: 'POST', headers: { Origin: ORIGIN, Cookie: consent.cookie }, body: form.toString() });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).not.toContain(KEY);
  });
});

describe('spending and revocation', () => {
  it('enforces a persistent daily cap, preserves media idempotency, and never retries', async () => {
    const auth = await connect({ scopes: ['omniakey:generate'], daily: 1 });
    const args = { request: { model: 'test-image', type: 'image', operation: 'generate', input: { prompt: 'test' }, parameters: { n: 1 } }, idempotency_key: 'one-intended-task' };
    keyPolicy();
    expectUpstream('/v1/media/tasks', KEY, { id: 'task_a', status: 'queued' }, 'POST', { 'Idempotency-Key': 'one-intended-task' }, 202);
    const first = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_submit_task', arguments: args });
    expect(await first.text()).toContain('task_a');
    const second = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_submit_task', arguments: { ...args, idempotency_key: 'different-task' } });
    expect(await second.text()).toContain('request_limit');
  });

  it('blocks paid calls if a key becomes unlimited after authorization', async () => {
    const auth = await connect({ scopes: ['omniakey:generate'] });
    keyPolicy(KEY, { hard_limit_usd: 100000000 });
    const response = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_chat', arguments: { request: { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } } });
    expect(await response.text()).toContain('limited_key_required');
  });

  it('globally limits concurrent paid calls across connections using the same key', async () => {
    const guard = env.CREDENTIAL_GUARD.getByName('guard-concurrency-test');
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    expect(await guard.register(a, Date.now() + 3600000, 20)).toEqual({ ok: true });
    expect(await guard.register(b, Date.now() + 3600000, 20)).toEqual({ ok: true });
    const results = await Promise.all([guard.acquire(a, true), guard.acquire(b, true), guard.acquire(a, true)]);
    expect(results.filter(r => r.ok)).toHaveLength(2);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, code: 'concurrency_limit' }]);
    await guard.revoke(a);
    expect(await guard.acquire(a, true)).toEqual({ ok: false, code: 'connection_revoked' });
  });

  it('does not submit generation when revoked during the quota preflight', async () => {
    const auth = await connect({ scopes: ['omniakey:generate'] });
    const mocked = vi.mocked(fetch);
    mocked.mockClear();
    mocked.mockImplementationOnce(async input => {
      expect(String(input)).toBe(`${API}/v1/dashboard/billing/subscription`);
      await runInDurableObject(env.CREDENTIAL_GUARD.getByName(await fingerprint(KEY)), async (_instance, state) => {
        state.storage.sql.exec('UPDATE connections SET revoked = 1');
      });
      return Response.json({ object: 'billing_subscription', hard_limit_usd: 10, access_until: Math.floor(Date.now() / 1000) + 3600 });
    });
    const response = await rpc(auth.access_token, 'tools/call', { name: 'omniakey_chat', arguments: { request: { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } } });
    expect(await response.text()).toContain('connection_revoked');
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('revokes through the browser without reflecting the key or allowing another key to revoke', async () => {
    const auth = await connect();
    const page = await req('/mcp/connections');
    const pageText = await page.text();
    const csrf = pageText.match(/name="csrf" value="([^"]+)"/)![1];
    const post = (form: URLSearchParams) => req('/mcp/connections', { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie(page) }, body: form.toString() });
    const listing = await post(new URLSearchParams({ csrf, api_key: KEY, action: 'list' }));
    const listingText = await listing.text();
    expect(listingText).not.toContain(KEY);
    const grantId = listingText.match(/name="grant_id" value="([^"]+)"/)![1];
    expect((await post(new URLSearchParams({ csrf, api_key: KEY2, action: 'revoke', grant_id: grantId }))).status).toBe(404);
    expect((await rpc(auth.access_token, 'tools/list')).status).toBe(200);
    expect((await post(new URLSearchParams({ csrf, api_key: KEY, action: 'revoke', grant_id: grantId }))).status).toBe(200);
    expect((await rpc(auth.access_token, 'tools/list')).status).toBe(401);
    expect((await req('/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.consent.client.client_id, resource: `${ORIGIN}/mcp` }).toString() })).status).toBe(400);
  });

  it('blocks a connection based on authoritative expiry even if OAuth KV still has its token', async () => {
    const auth = await connect();
    const guard = env.CREDENTIAL_GUARD.getByName(await fingerprint(KEY));
    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec('UPDATE connections SET expires = 1');
    });
    expect((await rpc(auth.access_token, 'tools/list')).status).toBe(401);
    expect((await req('/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.consent.client.client_id, resource: `${ORIGIN}/mcp` }).toString() })).status).toBe(400);
  });

  it('authorization codes cannot be exchanged twice', async () => {
    const auth = await connect();
    const response = await req('/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: auth.tokenForm.toString() });
    expect(response.status).toBe(400);
  });
});
