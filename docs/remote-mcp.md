# Remote OmniaKey MCP

Endpoint: **https://api.omniakey.com/mcp**. Transport: Streamable HTTP with OAuth authorization code + S256 PKCE. The Worker uses the caller's own OmniaKey API key, not a platform-paid key.

Setup page: [OmniaKey MCP](https://api.omniakey.com/mcp/). If you connected through the retired MCP subdomain, remove that server entry and authorize the new endpoint. Tokens are bound to their resource; do not copy old tokens to the new URL.

## Connect

1. Create a dedicated key in [API keys](https://omniakey.com/dashboard/tokens). Give it a small finite quota, an expiration date and only the models you need. Keep the key separate from other applications. IP restrictions must accommodate Cloudflare Worker egress; a restriction to your laptop's address will reject remote calls.
2. Add the endpoint to a client that supports remote MCP and OAuth. Start its authorization flow. No static client ID or API-key HTTP header is needed; dynamic client registration and Client ID Metadata Documents are supported.
3. On the **api.omniakey.com** authorization page, check the redirect destination. Enter the dedicated key into the password field. Read access is selected by default. Paid generation and cancellation are separate choices. Choose a daily paid-request limit and a connection lifetime.
4. Return to the client. For the first check, ask it to list tools, read the media schema and list accessible models without generating anything.

Your client receives separate OAuth credentials. Never give it the upstream key in chat, a tool argument, a URL or a shared configuration file. No external scripts, fonts or analytics run on the authorization page.

Text generation requires an explicit `max_tokens` or `max_completion_tokens` from 1 to 4096. Media submission requires a stable `idempotency_key` for each intended task; preserve the returned task ID. Use model documentation and current prices before requesting generation. Model-specific inputs are passed through the existing gateway contracts. Local files must be supplied by your client as supported inputs; the remote Worker cannot read your computer.

## Permissions and limits

| Control | Limit / behavior |
| --- | --- |
| Read scope | Model list, common schema, task get/wait |
| Generate scope | Paid chat and image/video/audio task submission |
| Cancel scope | Explicit task cancellation |
| Connection lifetime | 1 hour, 24 hours (default), or 7 days; capped by key expiry |
| Access token | 15 minutes; refresh still checks authoritative connection expiry/revocation |
| Paid attempts per connection | 1–20 per UTC day; default 5 |
| Paid attempts per API key | 6/minute, 30/hour, 100/UTC day across all connections |
| Concurrent paid HTTP requests | 2 per key; asynchronous tasks may continue after submission returns |
| Backend operations | 120/minute per key; a paid attempt includes its quota-policy preflight |
| Edge limit | 60 requests/minute per IP/category; regional abuse control, not a spending guarantee |
| Output | One completion/common media batch count per call; text cap 4096 tokens |
| HTTP size | 1 MiB MCP request, 8 MiB upstream response; smaller OAuth/form bodies |

Limits count accepted attempts, including policy-check failures and uncertain requests. Fixed windows can admit bursts at boundaries. Counters are held in a Durable Object per key fingerprint and cannot be reset by reconnecting. The API key's gateway quota remains the monetary control; request counts do not predict price or limit the number of media tasks already running. A raw key used directly against the API is outside MCP controls.

Manage or revoke grants at [connections](https://api.omniakey.com/mcp/connections), using the same dedicated key. Revocation blocks new calls through the authoritative guard before deleting the OAuth grant. Already submitted work may still finish. If the API key itself is compromised, disable it in the dashboard.

## Implementation and storage

The design follows ReachFaro's stateless MCP and Cloudflare OAuth consent approach, with OmniaKey-specific public API access and spending controls. It uses Cloudflare Workers, `@modelcontextprotocol/server`, `@cloudflare/workers-oauth-provider`, a dedicated `OAUTH_KV` namespace and the SQLite `CredentialGuard` Durable Object class. The CLI and stdio server retain their original local credential behavior.

- OAuth KV stores encrypted upstream key props and token hashes. Per-grant encryption keys are wrapped using bearer/code-derived keys by the OAuth provider; neither raw API keys nor raw OAuth access/refresh tokens are stored as metadata. Client registration and grant metadata are not secret-key storage.
- Durable Objects store connection IDs, expiry, revocation, usage counters and leases, addressed by SHA-256 key fingerprint. They store no raw keys, prompts, task inputs or model output. Expired guard rows are cleaned on subsequent activity.
- Only `https://api.omniakey.com/v1` is credentialed upstream. The Worker uses the existing public billing subscription endpoint to verify finite token quota and expiry at authorization and before paid work. If token-specific stats are disabled or cannot be verified, authorization fails closed. The compatibility field named `hard_limit_usd` follows the site's configured display units; it is not a live USD quote.
- No product database, browser session, service token, R2 asset credentials or Kubernetes access. The gateway still owns models, task ownership, routing, balances and billing.
- The sole issuer/host is `https://api.omniakey.com`; workers.dev and preview URLs are disabled. Origin, PKCE, consent cookie, body and redirect checks are enforced. Original keys cannot authenticate directly to `/mcp`.
- Only the MCP and discovery paths are routed to this Worker. Existing `/v1`, other data-plane paths and payment callbacks still use the existing API origin. Consent/CSRF cookies have an MCP-specific `__Host-` prefix; the Worker neither reads product sessions nor forwards incoming cookies upstream.
- Stored Worker logs and traces are disabled. Do not enable request-body/header/URL logging or run a production tail while people authorize. No shared runtime API secret needs to be configured.

## Validate and deploy

Deployment requires explicit user authorization for this repository's Cloudflare target. CI runs tests/build only and never deploys. Use a separate Worker, KV namespace, Durable Object namespace and issuer if creating another environment.

```bash
npm ci
npm run types:worker
npm run check
npm run check:worker
npm run build:worker
npm pack --dry-run
npm audit
npm run deploy:worker
```

`wrangler.jsonc` owns the `omniakey-mcp` Worker, path routes, bindings and SQLite migration. It uses the existing proxied API hostname without changing its DNS target or Kubernetes ingress. Never configure the whole API hostname as this Worker's custom domain. Keep the existing KV namespace and Durable Object migration when redeploying. Use the existing authenticated Wrangler login; never place its token in source or command arguments.

| Public path | Handler |
| --- | --- |
| `/mcp` | Authenticated Streamable HTTP |
| `/mcp/`, `/mcp/connections`, `/mcp/healthz` | Setup, connection management, health |
| `/mcp/oauth/authorize`, `/mcp/oauth/token`, `/mcp/oauth/register` | OAuth consent, token exchange, client registration |
| `/.well-known/oauth-authorization-server` | Authorization server discovery; issuer `https://api.omniakey.com` |
| `/.well-known/oauth-protected-resource/mcp` | Resource discovery for `/mcp` |

Cloudflare route patterns end in `*` so query strings match. The Worker enforces an exact path allowlist and returns 404 for other matching paths. Everything outside those route patterns continues to the existing origin. Before changing routing, record unauthenticated `/v1/models`, billing and public pricing responses; check the same paths afterwards. Retire any old MCP custom-domain binding only after the new endpoint is verified. Removing a custom domain from Wrangler configuration alone does not guarantee that the old binding is deleted.

After deployment, check `/mcp/healthz`, both OAuth metadata endpoints, unauthorized `/mcp`, client registration, browser consent, rejection of invalid keys/PKCE/audience, and a real MCP client handshake. With a dedicated test key, verify a read-only model list and revocation. Keep test credentials only in process memory or a private secret mechanism. Paid generation is not necessary for a protocol smoke test.

For a live read-only check from a source checkout, run `node scripts/smoke-remote.mjs` and open the printed authorization URL. Keep generation/cancellation unchecked and select a one-hour connection. Enter your key only on the hosted HTTPS page. The script listens on a temporary loopback callback, completes OAuth, initializes a real MCP client and lists models. It never sees your original API key or prints/saves OAuth credentials; it makes zero paid calls and exits after success or ten minutes. Revoke the temporary connection afterwards. On Node versions supporting it, add `--use-env-proxy` only if your terminal requires its configured HTTP proxy.

If clients receive a Cloudflare challenge/403 instead of OAuth JSON, inspect the affected hostname and client User-Agent. Do not disable zone-wide protection to make a test pass. Upstream requests identify themselves as `OmniaKey-MCP/0.2.0 (+https://api.omniakey.com/mcp/)`.

Use `wrangler deployments list` / `wrangler versions list` to identify the active release and `wrangler rollback <VERSION_ID>` to restore a known compatible one. Do not roll back to code that bypasses the guard or delete OAuth/DO storage to clear a rate limit. As an emergency user action, disable the compromised API key at the gateway; existing completed assets and submitted tasks follow the gateway's rules.

See [Cloudflare remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider) and [security policy](../SECURITY.md).

## Production verification — 2026-11-11

Worker `omniakey-mcp` deployed at `https://api.omniakey.com/mcp`; active version `69e0238e-b37b-487e-8e17-2480672fb5d6` (100% traffic). Dedicated OAuth KV ID: `3689c73e9b05486398fdf67d3899a5bd`. Wrangler reported 101 ms startup for this release. The deployment uses the three path routes above and created no shared paid key or new storage. It changed no Kubernetes, New API configuration or API DNS target. The old `mcp.omniakey.com` custom-domain binding was removed after verification; public DNS now returns NXDOMAIN for that hostname.

Certificate inventory: the retired binding referenced certificate `1faccde8-b8bd-43f7-8c2f-03d53a10f6cc`. Cloudflare [does not automatically remove its Advanced Certificate](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#certificates). The available Wrangler login received 403 when listing certificate packs, so no certificate was altered. A certificate administrator can inspect that exact reference for optional inventory cleanup; the old hostname has no DNS record or Worker binding.

Validation: 11 CLI/stdio integration tests and 17 Workers security/protocol tests passed, including API-host discovery/path boundaries and a real Streamable HTTP client against the Workers runtime with synthetic upstream fixtures. Typecheck, dry-run build and package inspection passed; the dependency audit found no known vulnerabilities during the original deployment, and this migration changes no dependencies.

Production checks on the new host passed for TLS/landing/management/health, OAuth metadata, dynamic registration, browser consent, deny redirect, invalid-key/bearer rejection, URL-credential rejection, foreign-origin rejection and missing-PKCE rejection. Native Node fetch received the expected OAuth 401 resource-metadata challenge. The browser rendered the new setup page without an edge challenge. Unauthenticated `/v1/models` and billing remained JSON 401, and public pricing remained JSON 200, matching the baseline. Payment callback paths are outside all three Worker routes; no payment transaction or callback POST was performed. The new health and MCP challenge remained correct after removing the old binding.

A live read-only verification helper is provided above; authenticated production model discovery still requires a real dedicated finite-budget, expiring key. No real API key or paid generation was used for this migration verification.
