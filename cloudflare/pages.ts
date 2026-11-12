import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { validateConnectionKey } from './client';
import { boundedText, escapeHtml as h, fingerprint, MAX_CONNECTION_SECONDS, pagePolicy, parseApiKey, SCOPES, type GrantProps } from './security';

const STYLE = `:root{color-scheme:light dark;font:16px/1.65 system-ui,sans-serif}body{margin:0;background:light-dark(#f6f7fb,#11141b);color:light-dark(#172033,#e8edf8)}main{max-width:580px;margin:5vh auto;padding:24px}.card{background:light-dark(white,#1a202b);border:1px solid #8884;border-radius:16px;padding:28px}h1{line-height:1.25;font-size:28px}h2{font-size:18px}.muted,small{color:light-dark(#536078,#a4b1c8)}.brand{font-weight:750;letter-spacing:.02em}.domain{font-size:22px;font-weight:700;overflow-wrap:anywhere}a{color:light-dark(#275bc5,#9dbbff)}label{display:block;margin:16px 0}input[type=password],input[type=number],select{display:block;box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid #8888;border-radius:8px;background:transparent;color:inherit}button{font:inherit;padding:10px 18px;margin:10px 8px 0 0;border-radius:8px;border:1px solid #8888;cursor:pointer}.primary{background:#285acd;color:#fff;border-color:#285acd}.notice{padding:12px;border-left:3px solid #d38b21;background:#d38b2114}.entry{padding:14px 0;border-top:1px solid #8884;overflow-wrap:anywhere}code{overflow-wrap:anywhere}`;

export function html(title: string, content: string, headers = new Headers(), status = 200): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${h(title)} · OmniaKey</title><style>${STYLE}</style></head><body><main><p class="brand">OmniaKey</p><div class="card">${content}</div></main></body></html>`, { status, headers });
}

export function errorPage(message: string, status = 400): Response {
  return html('Connection not completed', `<h1>Connection not completed</h1><p>${h(message)}</p><p><a href="/mcp/">Back to OmniaKey MCP</a></p>`, new Headers(), status);
}

export function landing(origin: string): Response {
  return html('Connect your AI assistant', `<h1>Use OmniaKey in your AI assistant</h1><p>Add this remote MCP URL in a client that supports Streamable HTTP and OAuth:</p><p><code>${h(origin)}/mcp</code></p><p>Connect with a dedicated OmniaKey API key. Give that key a small spending limit and an expiration date before connecting.</p><p><a href="https://omniakey.com/dashboard/tokens" rel="noreferrer">Create a limited API key</a></p><h2>You control access</h2><p>Read access is enabled by default. Generation and cancellation are optional. Choose a daily request limit and a connection lifetime during authorization.</p><p>Your API key stays with the OmniaKey service. Your assistant receives a separate, revocable token.</p><p><a href="/mcp/connections">Manage or revoke connections</a></p><p class="muted">Generation is billed to your API key at the selected model's rates. A request limit is not a dollar budget. Local files must be uploaded by your MCP client; this remote server cannot read your computer.</p>`);
}

function clientFacts(client: ConsentDescription): string {
  return `<p class="muted">The connection token will be delivered to</p><p class="domain">${h(client.redirectHost)}</p><p>Client name: ${h(client.clientName.slice(0, 100))}</p>${client.clientDomain ? `<p>Client metadata domain: ${h(client.clientDomain)}</p>` : '<p class="notice">The client supplies its own name. Check the destination above before authorizing.</p>'}${client.redirectIsLoopback ? '<p class="notice">This is a local application on your computer. Continue only if you just started connecting it.</p>' : ''}`;
}

function consentPage(client: ConsentDescription, handle: string, headers: Headers, redirectUri: string): Response {
  headers.set('Content-Security-Policy', pagePolicy(redirectUri));
  return html('Authorize your assistant', `<h1>Connect your AI assistant</h1>${clientFacts(client)}<form method="post" action="/mcp/oauth/authorize" autocomplete="off"><input type="hidden" name="handle" value="${h(handle)}"><label>Dedicated OmniaKey API key<input type="password" name="api_key" minlength="23" maxlength="131" autocomplete="off" spellcheck="false"></label><p class="muted">Use a key with a finite spending limit and an expiration date. <a href="https://omniakey.com/dashboard/tokens" target="_blank" rel="noreferrer noopener">Create or update a key</a>. Unlimited keys cannot connect.</p><label><input type="checkbox" checked disabled> Read models and task results</label><label><input type="checkbox" name="scope" value="omniakey:generate"> Allow paid text, image, video and audio generation</label><label><input type="checkbox" name="scope" value="omniakey:cancel"> Allow task cancellation</label><label>Maximum paid requests per UTC day<input type="number" name="daily_limit" value="5" min="1" max="20" required></label><label>Connection lifetime<select name="lifetime"><option value="3600">1 hour</option><option value="86400" selected>24 hours</option><option value="604800">7 days</option></select></label><p class="muted">The API key's spending limit is enforced by OmniaKey. Daily request limits do not specify a dollar amount. A request that may have reached the model counts toward the request limit even if the connection times out.</p><div><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Connect</button></div></form><p><a href="/mcp/connections">Manage connections</a></p>`, headers);
}

function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get('Origin') === origin;
}

function authorizationFailure(error: unknown): Response {
  // Never echo arbitrary library/upstream errors: they can contain inputs.
  if (error instanceof CimdFetchError) return errorPage('Could not load the client metadata. Restart the connection from your assistant.', 502);
  if (error instanceof AuthorizationError) return errorPage('This authorization is invalid, expired, or already used. Restart the connection from your assistant.');
  return errorPage('Could not verify the API key or complete authorization. Check its limit, expiration, balance and model access, then start a new connection.');
}

export async function authorize(request: Request, env: Env, helpers: OAuthHelpers): Promise<Response> {
  try {
    if (request.method === 'GET') {
      const auth = await helpers.parseAuthRequest(request);
      if (!auth.codeChallenge || auth.codeChallengeMethod !== 'S256') return errorPage('This client must use PKCE S256.');
      const client = await helpers.describeConsent(auth);
      const consent = await helpers.beginConsent(auth);
      return consentPage(client, consent.handle, consent.headers, auth.redirectUri);
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return errorPage('Submit this form from the OmniaKey authorization page.', 403);
    const form = new URLSearchParams(await boundedText(request, 8192));
    const handle = form.get('handle') ?? '';
    if (form.get('decision') !== 'approve') {
      const denied = await helpers.denyConsent(request, handle);
      denied.headers.set('Location', denied.redirectTo);
      return new Response(null, { status: 303, headers: denied.headers });
    }
    const scopes = ['omniakey:read', ...form.getAll('scope')];
    if (scopes.some(scope => !SCOPES.includes(scope))) return errorPage('Unknown permission.');
    const dailyLimit = Number(form.get('daily_limit'));
    const lifetime = Number(form.get('lifetime'));
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 20 || ![3600, 86400, MAX_CONNECTION_SECONDS].includes(lifetime)) return errorPage('Invalid request limit or connection lifetime.');
    // Consume and bind the consent before making any credentialed network call.
    const approved = await helpers.approveConsent(request, handle, { scope: [...new Set(scopes)] });
    if (!approved.request.codeChallenge || approved.request.codeChallengeMethod !== 'S256') return errorPage('This client must use PKCE S256.');
    const apiKey = parseApiKey(form.get('api_key'));
    const keyPolicy = await validateConnectionKey(apiKey);
    const credentialId = await fingerprint(apiKey);
    // Stable per consent: a repeated approval cannot create a second connection
    // while an eventually consistent KV deletion is still propagating.
    const consentHash = await fingerprint(handle);
    const connectionId = consentHash.slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const expiresAt = Math.min(Date.now() + lifetime * 1000, keyPolicy.expiresAt);
    const guard = env.CREDENTIAL_GUARD.getByName(credentialId);
    const registered = await guard.register(connectionId, expiresAt, dailyLimit);
    if (!registered.ok) return errorPage('Connection limit reached. Revoke an existing connection first.');
    try {
      const client = await helpers.describeConsent(approved.request);
      const props: GrantProps = { kind: 'omniakey-key', apiKey, credentialId, connectionId, expiresAt };
      const result = await helpers.completeAuthorization({
        request: approved.request, userId: credentialId,
        scope: [...new Set(scopes)], props,
        // Cleartext grant metadata must NEVER contain the API key.
        metadata: { connectionId, clientName: client.clientName.slice(0, 100), redirectHost: client.redirectHost, expiresAt, dailyLimit },
      });
      approved.headers.set('Location', result.redirectTo);
      return new Response(null, { status: 303, headers: approved.headers });
    } catch (error) {
      await guard.revoke(connectionId);
      throw error;
    }
  } catch (error) { return authorizationFailure(error); }
}

const CSRF_COOKIE = '__Host-omniakey-mcp-connections';
function managementForm(csrf: string, entries = ''): string {
  return `<h1>Manage connections</h1><p>Enter the dedicated API key you used to connect. This lists only connections created with that key. You can also disable the key in your <a href="https://omniakey.com/dashboard/tokens">OmniaKey dashboard</a>.</p><form method="post" action="/mcp/connections" autocomplete="off"><input type="hidden" name="csrf" value="${h(csrf)}"><label>OmniaKey API key<input type="password" name="api_key" maxlength="131" autocomplete="off" required></label>${entries}<button class="primary" name="action" value="list">List connections</button></form>`;
}

export async function connections(request: Request, env: Env, helpers: OAuthHelpers): Promise<Response> {
  if (request.method === 'GET') {
    const csrf = crypto.randomUUID();
    const headers = new Headers({ 'Set-Cookie': `${CSRF_COOKIE}=${csrf}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600` });
    return html('Manage connections', managementForm(csrf), headers);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return errorPage('Open the connection management page first.', 403);
  try {
    const form = new URLSearchParams(await boundedText(request, 8192));
    const csrf = form.get('csrf') ?? '';
    const cookie = (request.headers.get('Cookie') ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${CSRF_COOKIE}=`))?.slice(CSRF_COOKIE.length + 1) ?? '';
    if (!/^[a-f0-9-]{36}$/.test(csrf) || cookie.length !== csrf.length ||
        !crypto.subtle.timingSafeEqual(new TextEncoder().encode(cookie), new TextEncoder().encode(csrf))) return errorPage('The page expired. Open connection management again.', 403);
    const credentialId = await fingerprint(parseApiKey(form.get('api_key')));
    const grants = await helpers.listUserGrants(credentialId, { limit: 100 });
    if (form.get('action') === 'revoke') {
      const grant = grants.items.find(g => g.id === form.get('grant_id'));
      if (!grant || typeof grant.metadata?.connectionId !== 'string') return errorPage('Connection not found.', 404);
      // This authoritative stop takes effect even if KV revocation is delayed.
      await env.CREDENTIAL_GUARD.getByName(credentialId).revoke(grant.metadata.connectionId);
      await helpers.revokeGrant(grant.id, credentialId);
      return html('Connection revoked', `<h1>Connection revoked</h1><p>New tool calls are blocked. Generation already submitted to a model may still finish.</p><a href="/mcp/connections">Manage other connections</a>`);
    }
    const entries = grants.items.map(g => `<div class="entry"><label><input type="radio" name="grant_id" value="${h(g.id)}"> ${h(String(g.metadata?.clientName ?? 'AI assistant'))} — ${h(String(g.metadata?.redirectHost ?? ''))}</label><small>Expires: ${h(new Date(Number(g.metadata?.expiresAt ?? 0)).toISOString())}; paid calls/day: ${h(String(g.metadata?.dailyLimit ?? ''))}</small></div>`).join('');
    return html('Your connections', managementForm(csrf, `${entries || '<p>No connections for this key.</p>'}${entries ? '<button name="action" value="revoke">Revoke selected connection</button><p class="muted">Re-enter the key to confirm revocation. It is never included in this page.</p>' : ''}`));
  } catch { return errorPage('Could not manage this connection. Check the key and restart from the management page.'); }
}
