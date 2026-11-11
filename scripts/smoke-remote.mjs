// Read-only live verification. OAuth credentials exist only in this process.
// The original API key is entered in the hosted consent page, never here.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'https://mcp.omniakey.com';
const state = randomBytes(32).toString('base64url');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
let registration;
let redirectUri;
let used = false;
const jsonFetch = async (path, body, contentType = 'application/json') => {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': contentType, 'User-Agent': 'OmniaKey-MCP-Smoke/0.2.0' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Endpoint rejected verification: HTTP ${response.status}`);
  return response.json();
};
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(request.url, redirectUri);
  const suppliedState = url.searchParams.get('state') ?? '';
  if (used || request.method !== 'GET' || url.pathname !== '/callback' || suppliedState.length !== state.length ||
      !timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state))) {
    response.writeHead(400).end('Invalid verification callback.');
    return;
  }
  used = true;
  const client = new Client({ name: 'omniakey-deployment-check', version: '0.2.0' });
  try {
    if (!url.searchParams.has('code')) throw new Error('Authorization was not approved.');
    const token = await jsonFetch('/oauth/token', new URLSearchParams({
      grant_type: 'authorization_code', code: url.searchParams.get('code'),
      client_id: registration.client_id, redirect_uri: redirectUri,
      code_verifier: verifier, resource: `${origin}/mcp`,
    }).toString(), 'application/x-www-form-urlencoded');
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.some(tool => ['omniakey_chat', 'omniakey_submit_task', 'omniakey_cancel_task'].includes(tool.name))) {
      throw new Error('This verification requires read-only consent. Revoke it and reconnect without paid/cancel scopes.');
    }
    const result = await client.callTool({ name: 'omniakey_models', arguments: { limit: 1 } });
    if (result.isError) throw new Error('Model discovery failed; check key validity, limits and model permissions.');
    console.log(JSON.stringify({ liveOAuth: 'passed', mcpHandshake: 'passed', tools: tools.tools.length, modelDiscovery: 'passed', paidCalls: 0 }));
    response.end('OmniaKey live verification passed: OAuth, MCP handshake and authenticated model discovery. No paid request was made. You may close this tab and revoke the test connection at https://mcp.omniakey.com/connections .');
  } catch (error) {
    // Do not print arbitrary SDK/upstream errors that might include credentials.
    console.error('Live verification failed. Check the key policy and repeat browser authorization; no paid request was made.');
    response.writeHead(400).end('Verification failed. No paid request was made. Revoke this test connection and restart authorization.');
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    server.close();
    clearTimeout(deadline);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
const deadline = setTimeout(() => {
  console.error('Verification expired without browser authorization.');
  server.close();
  process.exitCode = 1;
}, 10 * 60_000);
try {
  registration = await jsonFetch('/oauth/register', {
    client_name: 'OmniaKey read-only deployment check', redirect_uris: [redirectUri],
    grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none',
  });
  const query = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: redirectUri, response_type: 'code',
    resource: `${origin}/mcp`, scope: 'omniakey:read', code_challenge: challenge,
    code_challenge_method: 'S256', state,
  });
  console.log('Keep read-only access and choose a one-hour connection. Enter your limited API key only in this browser page:');
  console.log(`${origin}/oauth/authorize?${query}`);
} catch {
  console.error('Could not start live verification; no credentials were printed or saved.');
  server.close();
  clearTimeout(deadline);
  process.exitCode = 1;
}
