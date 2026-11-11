# OmniaKey developer tools

This public MIT repository owns the Node.js CLI, local stdio MCP, Cloudflare remote MCP and `skills/omniakey-models`. The display brand is **OmniaKey**. The separate `ai-agent-api-setup` project configures third-party model providers.

- Use the public Bearer API only. Do not add browser session, internal service token, database or cluster access.
- Keep transport behavior in `src/client.mjs` and tool registration in `src/tools.mjs`. `cloudflare/client.ts` adds remote limits without weakening shared validation or recovery.
- Never automatically retry paid requests. Media submission requires a stable idempotency key and preserves the returned `id`.
- Timeouts do not cancel or recreate remote tasks. Return actual terminal states and recovery information.
- Never accept API keys in CLI arguments, MCP tool inputs or URLs. Local tools read the environment only. Remote MCP accepts a dedicated finite-budget, expiring key only in the HTTPS OAuth consent/management form; encrypt it in OAuth props, never in metadata, logs or source. There is no shared platform-paid key.
- Remote OAuth uses browser-bound consent, S256 PKCE, explicit generate/cancel scopes, short access tokens and authoritative Durable Object revocation/limits per key fingerprint. Do not replace global counters with regional KV or in-memory counters.
- The remote upstream is fixed to `https://api.omniakey.com/v1`, with an identified product User-Agent. Reject redirects. No user-controlled base URL, cookie forwarding, account creation or internal credentials.
- `schema` describes the common envelope; model-specific capabilities and prices need their own authoritative source. Do not market static envelopes as a live capability catalog.
- Keep stdout JSON-only for CLI and JSON-RPC-only for MCP. Human diagnostics go to stderr.
- Run `npm run check`, `npm run check:worker`, `npm run build:worker` and `npm pack --dry-run` before commit. Tests use fixtures and real MCP clients, never paid requests. Run `npm run types:worker` when bindings change.
- Pin existing source distribution tags in local installation examples. Remote connection instructions and production operations live in `docs/remote-mcp.md`; do not advertise an unpublished npm package.
- CI validates source, Worker build and packaging only. Publishing/deployment requires explicit user authorization. Deploy only this repo's Worker and resources; never modify New API/Kubernetes as an implicit dependency.
