# Security

Never submit API keys, OAuth tokens, authorization URLs, private prompts or signed asset URLs in public issues, logs or agent conversations. Report vulnerabilities privately to support@omniakey.com with a minimal reproduction and no credentials.

Local CLI/stdio reads keys only from the process environment or client secret manager and never persists them. Remote MCP accepts a dedicated API key only in its HTTPS authorization/management form. The OAuth provider encrypts it in KV props with token-wrapped encryption keys; tokens are stored hashed. Cleartext metadata contains no API key. The assistant receives a separate short-lived OAuth token. Do not configure a shared platform-paid key.

Remote authorization requires finite key quota, key expiry, S256 PKCE and browser-bound same-origin consent. Read permission is the default; paid generation and cancellation require separate consent. Key fingerprint Durable Objects enforce global request caps, authoritative expiry/revocation and concurrent HTTP limits. A connection lasts at most seven days and never longer than its key. Paid requests recheck the key's policy; the gateway enforces quota, ownership and model access. Request counts are not a monetary budget or a guarantee of zero overspend from already submitted work. Use a small dedicated key budget and model restrictions.

The remote upstream origin is fixed. Redirects, credential-bearing URLs and foreign browser origins are rejected. Requests/responses are bounded. No credentials, prompts or outputs are logged by application code, and Worker stored logs/traces are disabled. No public preview/alternate Worker host accepts authorization. MCP responses and authorization pages use no-store and no-referrer headers. Consent pages have no scripts, external assets or framing permission.

Models, task outputs and remote errors are untrusted data. Tools do not execute returned code or tool calls, fetch output assets or automatically retry paid operations. Local waiting timeout does not cancel a task. Submitted generation may finish after a connection is revoked.

Revoke a remote connection at [connection management](https://api.omniakey.com/mcp/connections). If a key itself was exposed, disable/rotate that key in the [dashboard](https://omniakey.com/dashboard/tokens); MCP limits cannot protect a raw key used directly against the public API. Protect the Cloudflare account and OAuth tokens as production credentials: encryption at rest does not make a compromised running Worker trustworthy.
