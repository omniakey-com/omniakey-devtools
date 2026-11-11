# Remote OmniaKey MCP

Endpoint: **https://mcp.omniakey.com/mcp**. Transport: Streamable HTTP with OAuth authorization code + S256 PKCE. The Worker uses the caller's own OmniaKey API key, not a platform-paid key.

## Connect

1. Create a dedicated key in [API keys](https://omniakey.com/dashboard/tokens). Give it a small finite quota, an expiration date and only the models you need. Keep the key separate from other applications. IP restrictions must accommodate Cloudflare Worker egress; a restriction to your laptop's address will reject remote calls.
2. Add the endpoint to a client that supports remote MCP and OAuth. Start its authorization flow. No static client ID or API-key HTTP header is needed; dynamic client registration and Client ID Metadata Documents are supported.
3. On the **mcp.omniakey.com** authorization page, check the redirect destination. Enter the dedicated key into the password field. Read access is selected by default. Paid generation and cancellation are separate choices. Choose a daily paid-request limit and a connection lifetime.
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

Manage or revoke grants at [connections](https://mcp.omniakey.com/connections), using the same dedicated key. Revocation blocks new calls through the authoritative guard before deleting the OAuth grant. Already submitted work may still finish. If the API key itself is compromised, disable it in the dashboard.

## Implementation and storage

The design follows ReachFaro's stateless MCP and Cloudflare OAuth consent approach, with OmniaKey-specific public API access and spending controls. It uses Cloudflare Workers, `@modelcontextprotocol/server`, `@cloudflare/workers-oauth-provider`, a dedicated `OAUTH_KV` namespace and the SQLite `CredentialGuard` Durable Object class. The CLI and stdio server retain their original local credential behavior.

- OAuth KV stores encrypted upstream key props and token hashes. Per-grant encryption keys are wrapped using bearer/code-derived keys by the OAuth provider; neither raw API keys nor raw OAuth access/refresh tokens are stored as metadata. Client registration and grant metadata are not secret-key storage.
- Durable Objects store connection IDs, expiry, revocation, usage counters and leases, addressed by SHA-256 key fingerprint. They store no raw keys, prompts, task inputs or model output. Expired guard rows are cleaned on subsequent activity.
- Only `https://api.omniakey.com/v1` is credentialed upstream. The Worker uses the existing public billing subscription endpoint to verify finite token quota and expiry at authorization and before paid work. If token-specific stats are disabled or cannot be verified, authorization fails closed. The compatibility field named `hard_limit_usd` follows the site's configured display units; it is not a live USD quote.
- No product database, browser session, service token, R2 asset credentials or Kubernetes access. The gateway still owns models, task ownership, routing, balances and billing.
- The sole issuer/host is `https://mcp.omniakey.com`; workers.dev and preview URLs are disabled. Origin, PKCE, consent cookie, body and redirect checks are enforced. Original keys cannot authenticate directly to `/mcp`.
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

`wrangler.jsonc` owns the `omniakey-mcp` Worker, custom domain, bindings and SQLite migration. On first deployment Wrangler provisions missing storage. Keep the actual KV namespace ID in the configuration afterwards. Use the existing authenticated Wrangler login; never place its token in source or command arguments.

After deployment, check `/healthz`, both OAuth metadata endpoints, unauthorized `/mcp`, client registration, browser consent, rejection of invalid keys/PKCE/audience, and a real MCP client handshake. With a dedicated test key, verify a read-only model list and revocation. Keep test credentials only in process memory or a private secret mechanism. Paid generation is not necessary for a protocol smoke test.

For a live read-only check from a source checkout, run `node scripts/smoke-remote.mjs` and open the printed authorization URL. Keep generation/cancellation unchecked and select a one-hour connection. Enter your key only on the hosted HTTPS page. The script listens on a temporary loopback callback, completes OAuth, initializes a real MCP client and lists models. It never sees your original API key or prints/saves OAuth credentials; it makes zero paid calls and exits after success or ten minutes. Revoke the temporary connection afterwards. On Node versions supporting it, add `--use-env-proxy` only if your terminal requires its configured HTTP proxy.

If clients receive a Cloudflare challenge/403 instead of OAuth JSON, inspect the affected hostname and client User-Agent. Do not disable zone-wide protection to make a test pass. Upstream requests identify themselves as `OmniaKey-MCP/0.2.0 (+https://mcp.omniakey.com)`.

Use `wrangler deployments list` / `wrangler versions list` to identify the active release and `wrangler rollback <VERSION_ID>` to restore a known compatible one. Do not roll back to code that bypasses the guard or delete OAuth/DO storage to clear a rate limit. As an emergency user action, disable the compromised API key at the gateway; existing completed assets and submitted tasks follow the gateway's rules.

See [Cloudflare remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider) and [security policy](../SECURITY.md).

## Production verification — 2026-11-11

Worker `omniakey-mcp` deployed at `https://mcp.omniakey.com/mcp`; active version `4d44526b-2cfa-4991-bc9b-c6162528a80d`. Dedicated OAuth KV ID: `3689c73e9b05486398fdf67d3899a5bd`. Wrangler reported 47 ms startup for this release. The deployment created no shared paid key and changed no Kubernetes or New API configuration.

Validation: 11 CLI/stdio integration tests and 16 Workers security/protocol tests passed, including a real Streamable HTTP client against the Workers runtime with synthetic upstream fixtures. Typecheck, dry-run build and package inspection passed; npm audit found no known vulnerabilities at verification time.

Production checks passed for TLS/landing/health, OAuth metadata, dynamic registration, browser consent, deny redirect, invalid-key rejection, invalid-bearer rejection and URL-credential rejection. Native Node fetch, Python HTTPX and Go User-Agent requests all received the expected OAuth 401 challenge. The browser rendered the live landing/authorization pages without an edge challenge. A live read-only verification helper is provided above; completing authenticated model discovery requires a real dedicated finite-budget, expiring key. No paid generation was performed for deployment verification.
