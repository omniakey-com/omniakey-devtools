import { ToolError } from '../src/client.mjs';

export const API_BASE = 'https://api.omniakey.com/v1';
export const SCOPES = ['omniakey:read', 'omniakey:generate', 'omniakey:cancel'];
export const READ_TOOLS = ['omniakey_models', 'omniakey_schema', 'omniakey_get_task', 'omniakey_wait_task'];
export const GENERATE_TOOLS = ['omniakey_chat', 'omniakey_submit_task'];
export const MAX_CONNECTION_SECONDS = 7 * 86400;

export interface GrantProps {
  kind: 'omniakey-key';
  apiKey: string;
  credentialId: string;
  connectionId: string;
  expiresAt: number;
}

export function parseApiKey(value: unknown): string {
  if (typeof value !== 'string' || !/^sk-[A-Za-z0-9]{20,128}$/.test(value.trim())) {
    throw new ToolError('invalid_key', 'Enter an OmniaKey API key without routing suffixes.');
  }
  return value.trim();
}

export async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function validProps(value: unknown): value is GrantProps {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<GrantProps>;
  return p.kind === 'omniakey-key' && typeof p.apiKey === 'string' &&
    typeof p.credentialId === 'string' && /^[a-f0-9]{64}$/.test(p.credentialId) &&
    typeof p.connectionId === 'string' && /^[a-f0-9-]{36}$/.test(p.connectionId) &&
    typeof p.expiresAt === 'number' && p.expiresAt > Date.now();
}

export function toolsForScopes(scopes: readonly string[]): Set<string> {
  const tools = new Set<string>();
  if (scopes.includes('omniakey:read')) READ_TOOLS.forEach(t => tools.add(t));
  if (scopes.includes('omniakey:generate')) GENERATE_TOOLS.forEach(t => tools.add(t));
  if (scopes.includes('omniakey:cancel')) tools.add('omniakey_cancel_task');
  return tools;
}

export function checkKeyPolicy(data: unknown): { expiresAt: number } {
  if (!data || typeof data !== 'object') throw new ToolError('key_policy_unavailable', 'Could not verify the API key limits.');
  const info = data as Record<string, unknown>;
  const expiry = info.access_until;
  const limit = info.hard_limit_usd;
  // In New API's compatibility endpoint an account-wide summary has no
  // access_until; unlimited keys use the explicit 100,000,000 sentinel.
  // Fail closed if token-specific limits cannot be established. Monetary units
  // follow site configuration: never label this field as a live USD quote.
  if (info.object !== 'billing_subscription' || typeof expiry !== 'number' ||
      !Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000 ||
      typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 || limit >= 100_000_000) {
    throw new ToolError('limited_key_required', 'Use a dedicated API key with a finite spending limit and an expiration date. Unlimited or unverifiable keys cannot connect.');
  }
  return { expiresAt: expiry * 1000 };
}

export function validatePaidRequest(path: string, body: unknown): void {
  if (!body || typeof body !== 'object') throw new ToolError('invalid_input', 'A request body is required.');
  const request = body as Record<string, unknown>;
  if (path === '/chat/completions') {
    if (request.n !== undefined && request.n !== 1) throw new ToolError('invalid_input', 'Remote MCP supports one completion per call.');
    const limits = [request.max_tokens, request.max_completion_tokens].filter(v => v !== undefined);
    if (!limits.length || limits.some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4096)) {
      throw new ToolError('output_limit_required', 'Set max_tokens or max_completion_tokens to an integer from 1 to 4096.');
    }
  }
  for (const values of [request, request.input, request.parameters]) {
    if (!values || typeof values !== 'object') continue;
    for (const field of ['n', 'batch_size', 'num_images', 'num_outputs', 'number_of_images']) {
      const value = (values as Record<string, unknown>)[field];
      if (value !== undefined && value !== 1) throw new ToolError('invalid_input', 'Remote MCP supports one output per call; submit separate intended tasks explicitly.');
    }
  }
}

export async function boundedText(request: Request, maxBytes: number): Promise<string> {
  const length = request.headers.get('Content-Length');
  if (length && Number(length) > maxBytes) throw new ToolError('request_too_large', 'Request too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ToolError('request_too_large', 'Request too large.');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function pagePolicy(redirectUri?: string): string {
  // Chrome applies form-action to the POST's OAuth redirect as well. Allow
  // only the already validated callback origin, never arbitrary form input.
  const callback = redirectUri ? new URL(redirectUri) : undefined;
  const destination = callback && ['https:', 'http:'].includes(callback.protocol) ? ` ${callback.origin}` : '';
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${destination}; frame-ancestors 'none'; base-uri 'none'`;
}

export function safeHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', pagePolicy());
  return new Response(response.body, { status: response.status, headers });
}
