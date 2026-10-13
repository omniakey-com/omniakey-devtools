import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OmniaKeyClient, normalizeBaseUrl, redact } from '../src/client.mjs';
import { schemaFor } from '../src/contracts.mjs';

const key = 'sk-test-only-never-real';
const media = { model: 'image-test', type: 'image', operation: 'generate', input: { prompt: 'A paper boat' }, parameters: { n: 1 } };
const cliFile = fileURLToPath(new URL('../bin/omniakey.mjs', import.meta.url));

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const request = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    if (handler) return handler(request, res, requests);
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'chat-test' }, { id: 'image-test' }] }));
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ id: 'chat-1', choices: [{ message: { content: 'Hello' } }] }));
    if (req.method === 'POST' && req.url === '/v1/media/tasks') {
      res.statusCode = 202;
      return res.end(JSON.stringify({ id: 'task_1', status: 'queued' }));
    }
    if (req.url === '/v1/media/tasks/task_1/cancel') return res.end(JSON.stringify({ id: 'task_1', status: 'canceled' }));
    return res.end(JSON.stringify({ id: 'task_1', status: 'succeeded', assets: [{ url: 'https://assets.example/result.png', expires_at: '2026-10-13T12:00:00Z' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, client: new OmniaKeyClient({ baseUrl, apiKey: key }) };
}

async function cli(args, baseUrl, input, apiKey = key) {
  const p = spawn(process.execPath, [cliFile, ...args], { env: { ...process.env, OMNIAKEY_BASE_URL: baseUrl, OMNIAKEY_API_KEY: apiKey }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', c => { stdout += c; });
  p.stderr.on('data', c => { stderr += c; });
  p.stdin.end(input);
  const [code] = await once(p, 'close');
  return { code, stdout, stderr, json: stdout.startsWith('{') ? JSON.parse(stdout) : undefined };
}

test('base URLs append v1 once and refuse unsafe credential destinations', () => {
  assert.equal(normalizeBaseUrl('https://api.omniakey.com'), 'https://api.omniakey.com/v1');
  assert.equal(normalizeBaseUrl('https://api.omniakey.com/v1/'), 'https://api.omniakey.com/v1');
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com?a=b', 'https://example.com/#fragment', 'file:///tmp/api']) assert.throws(() => normalizeBaseUrl(url));
  assert.deepEqual(redact({ a: ['key"\\value'] }, 'key"\\value'), { a: ['[REDACTED]'] });
});

test('model discovery and chat forward authentication and exact request fields', async t => {
  const { client, requests } = await fixture(t);
  assert.equal((await client.models({ search: 'IMAGE', limit: 1 })).data[0].id, 'image-test');
  const completion = await client.chat({ model: 'chat-test', messages: [{ role: 'user', content: 'Hello' }], temperature: 0.2 });
  assert.equal(completion.choices[0].message.content, 'Hello');
  assert.equal(requests[1].headers.authorization, `Bearer ${key}`);
  assert.equal(requests[1].body.temperature, 0.2);
  assert.equal(requests[1].body.stream, false);
  await assert.rejects(client.chat({ model: 'x', messages: [], stream: true }));
  await assert.rejects(client.models({ limit: 0 }));
  assert.equal(requests.length, 2);
});

test('media preserves idempotency, task id and assets across submit, read and cancel', async t => {
  const { client, requests } = await fixture(t);
  const result = await client.submit(media, 'one-intended-task');
  assert.equal(result.id, 'task_1');
  assert.equal(result.idempotency_key, 'one-intended-task');
  assert.equal(requests[0].headers['idempotency-key'], 'one-intended-task');
  assert.deepEqual(requests[0].body, media);
  assert.equal((await client.waitTask(result.id)).assets[0].url, 'https://assets.example/result.png');
  assert.equal((await client.cancelTask(result.id)).status, 'canceled');
  assert.equal(requests[2].url, '/v1/media/tasks/task_1/cancel');
  await assert.rejects(client.submit(media, ''));
  await assert.rejects(client.getTask('../models'));
  await assert.rejects(client.submit({ ...media, unknown: true }, 'a'));
  assert.equal(requests.length, 3);
});

test('wait timeout only stops local polling and preserves the original task', async t => {
  const { client, requests } = await fixture(t, (_req, res) => res.end(JSON.stringify({ id: 'task_1', status: 'processing' })));
  const result = await client.waitTask('task_1', { timeoutSeconds: 1, intervalSeconds: 1 });
  assert.equal(result.wait_timed_out, true);
  assert.equal(result.id, 'task_1');
  assert.equal(result.status, 'processing');
  assert.ok(requests.every(r => r.method === 'GET'));
});

test('terminal task failures remain task results and HTTP errors are never retried', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ id: 'task_1', status: 'failed', error: { code: 'provider_failed', message: 'Generation failed' } })));
  const result = await f.client.waitTask('task_1');
  assert.equal(result.status, 'failed');
  assert.equal(result.wait_timed_out, false);
  const e = await fixture(t, (_req, res) => { res.statusCode = 429; res.end(JSON.stringify({ error: { code: 'rate_limited', message: `Do not expose ${key}` } })); });
  await assert.rejects(e.client.submit(media, 'stable-key'), error => {
    assert.equal(error.details.idempotency_key, 'stable-key');
    assert.equal(error.details.status, 429);
    assert.ok(!error.message.includes(key));
    return true;
  });
  assert.equal(e.requests.length, 1);
});

test('network timeouts preserve submission key and wait failures preserve task id', async t => {
  const f = await fixture(t, () => {});
  const client = new OmniaKeyClient({ baseUrl: f.baseUrl, apiKey: key, timeoutMs: 40 });
  await assert.rejects(client.submit(media, 'recover-me'), e => e.code === 'request_timeout' && e.details.idempotency_key === 'recover-me');
  await assert.rejects(client.waitTask('task_1'), e => e.code === 'request_timeout' && e.details.task_id === 'task_1');
});

test('HTTP redirects never forward API keys to a different origin', async t => {
  const destination = await fixture(t);
  const source = await fixture(t, (_req, res) => { res.statusCode = 307; res.setHeader('Location', `${destination.baseUrl}/v1/models`); res.end('{}'); });
  await assert.rejects(source.client.models(), e => e.code === 'network_error');
  assert.equal(destination.requests.length, 0);
});

test('invalid edge responses and mismatched task ids fail clearly', async t => {
  const edge = await fixture(t, (_req, res) => { res.statusCode = 403; res.end('<html>denied</html>'); });
  await assert.rejects(edge.client.models(), e => e.code === 'invalid_response' && e.details.status === 403);
  const mismatch = await fixture(t, (_req, res) => res.end(JSON.stringify({ id: 'other_task', status: 'succeeded' })));
  await assert.rejects(mismatch.client.getTask('task_1'), e => e.code === 'invalid_response');
});

test('CLI handles stdin, strict flags, JSON output and useful exit codes', async t => {
  const f = await fixture(t);
  assert.equal((await cli(['models'], f.baseUrl, '', '')).json.error.code, 'missing_api_key');
  assert.equal((await cli(['models', '--api-key', 'do-not-use'], f.baseUrl)).code, 1);
  const submitted = await cli(['submit', '--file', '-', '--idempotency-key', 'cli-key'], f.baseUrl, JSON.stringify(media));
  assert.equal(submitted.code, 0);
  assert.equal(submitted.json.idempotency_key, 'cli-key');
  const run = await cli(['run', '--file', '-', '--idempotency-key', 'run-key'], f.baseUrl, JSON.stringify(media));
  assert.equal(run.code, 0);
  assert.equal(run.json.status, 'succeeded');
  assert.equal(JSON.parse(run.stderr).task_id, 'task_1');
  const before = f.requests.length;
  assert.equal((await cli(['run', '--file', '-', '--idempotency-key', 'bad-wait', '--timeout', 'nan'], f.baseUrl, JSON.stringify(media))).code, 1);
  assert.equal(f.requests.length, before);
  assert.equal((await cli(['task', 'cancel', 'task_1'], f.baseUrl)).code, 2);
  assert.equal((await cli(['schema', 'media'], f.baseUrl, '', '')).json.endpoint, 'POST /v1/media/tasks');
  assert.equal(schemaFor('chat').schema.properties.stream.const, false);
});

test('CLI timeout exits 3, preserves task and performs no second submission', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ id: 'task_1', status: 'processing' })));
  const result = await cli(['run', '--file', '-', '--idempotency-key', 'slow-key', '--timeout', '1', '--interval', '1'], f.baseUrl, JSON.stringify(media));
  assert.equal(result.code, 3);
  assert.equal(result.json.id, 'task_1');
  assert.equal(result.json.idempotency_key, 'slow-key');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('real stdio MCP initialization, discovery and calls use the same gateway contract', async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliFile, 'mcp'], env: { ...process.env, OMNIAKEY_API_KEY: key, OMNIAKEY_BASE_URL: f.baseUrl }, stderr: 'pipe' });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const list = await client.listTools();
  assert.equal(list.tools.length, 7);
  assert.equal(list.tools.find(t => t.name === 'omniakey_chat').annotations.readOnlyHint, false);
  assert.equal(list.tools.find(t => t.name === 'omniakey_submit_task').annotations.idempotentHint, true);
  assert.equal((await client.callTool({ name: 'omniakey_models', arguments: { search: 'chat' } })).structuredContent.data[0].id, 'chat-test');
  assert.equal((await client.callTool({ name: 'omniakey_schema', arguments: { kind: 'media' } })).structuredContent.endpoint, 'POST /v1/media/tasks');
  const submitted = await client.callTool({ name: 'omniakey_submit_task', arguments: { request: media, idempotency_key: 'mcp-key' } });
  assert.equal(submitted.structuredContent.id, 'task_1');
  const done = await client.callTool({ name: 'omniakey_get_task', arguments: { task_id: 'task_1' } });
  assert.equal(done.structuredContent.status, 'succeeded');
  const canceled = await client.callTool({ name: 'omniakey_cancel_task', arguments: { task_id: 'task_1' } });
  assert.equal(canceled.isError, true);
  assert.equal(canceled.structuredContent.status, 'canceled');
  const invalid = await client.callTool({ name: 'omniakey_submit_task', arguments: { request: media } });
  assert.equal(invalid.isError, true);
  assert.equal(f.requests.filter(r => r.url === '/v1/media/tasks').length, 1);
});
