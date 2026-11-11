import { OmniaKeyClient, ToolError } from '../src/client.mjs';
import { API_BASE, checkKeyPolicy, validatePaidRequest, type GrantProps } from './security';

const UPSTREAM_HEADERS = { 'User-Agent': 'OmniaKey-MCP/0.2.0 (+https://mcp.omniakey.com)' };

export class RemoteClient extends OmniaKeyClient {
  constructor(private readonly env: Env, private readonly grant: GrantProps) {
    super({ apiKey: grant.apiKey, baseUrl: API_BASE, timeoutMs: 120_000 });
  }

  override async request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const guard = this.env.CREDENTIAL_GUARD.getByName(this.grant.credentialId);
    const paid = options.method === 'POST' && (path === '/chat/completions' || path === '/media/tasks');
    const active = await guard.check(this.grant.connectionId);
    if (!active.ok) throw new ToolError(active.code, 'This connection expired or was revoked. Reconnect from your MCP client.');
    if (paid) validatePaidRequest(path, options.body);
    const allowance = await guard.acquire(this.grant.connectionId, paid);
    if (!allowance.ok) throw new ToolError(allowance.code, 'Connection inactive or request limit reached. Do not repeatedly retry; check your connection limits.');
    try {
      if (paid) {
        // Apply global limits before any network call. Recheck revoked,
        // depleted, expired or newly unlimited keys before sending paid work.
        // Keep preflight + generation below the persistent 150-second lease.
        const policyDeadline = AbortSignal.timeout(10_000);
        const policySignal = options.signal ? AbortSignal.any([options.signal, policyDeadline]) : policyDeadline;
        checkKeyPolicy(await super.request('/dashboard/billing/subscription', { signal: policySignal, headers: UPSTREAM_HEADERS }));
        if (!(await guard.check(this.grant.connectionId)).ok) {
          throw new ToolError('connection_revoked', 'Connection expired or was revoked before submission. No generation was submitted.');
        }
      }
      return await super.request(path, { ...options, headers: { ...options.headers, ...UPSTREAM_HEADERS } });
    } finally {
      // A cleanup failure must never hide the result/id of a paid operation.
      // The persistent lease expires by itself if release fails.
      if (allowance.lease) await guard.release(allowance.lease).catch(() => undefined);
    }
  }
}

export async function validateConnectionKey(apiKey: string): Promise<{ expiresAt: number }> {
  const client = new OmniaKeyClient({ apiKey, baseUrl: API_BASE, timeoutMs: 10_000 });
  return checkKeyPolicy(await client.request('/dashboard/billing/subscription', { headers: UPSTREAM_HEADERS }));
}
