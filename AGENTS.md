# OmniaKey developer tools

This public MIT repository owns the Node.js CLI, stdio MCP server and `skills/omniakey-models`. The display brand is **OmniaKey**. The separate `ai-agent-api-setup` project configures third-party model providers.

- Use the public Bearer API only. Do not add browser session, internal service token, database or cluster access.
- Keep transport behavior in `src/client.mjs`; CLI and MCP must share validation and recovery semantics.
- Never automatically retry paid requests. Media submission requires a stable idempotency key and preserves the returned `id`.
- Timeouts do not cancel or recreate remote tasks. Return actual terminal states and recovery information.
- Never accept API keys in CLI arguments or MCP tool inputs. Environment only; never write keys to disk/logs.
- `schema` describes the common envelope; model-specific capabilities and prices need their own authoritative source. Do not market static envelopes as a live capability catalog.
- Keep stdout JSON-only for CLI and JSON-RPC-only for MCP. Human diagnostics go to stderr.
- Run `npm run check` and `npm pack --dry-run` before commit. Tests use local HTTP fixtures and a real MCP stdio client, not paid requests.
- Pin source distribution tags in installation examples. Do not advertise an unpublished npm package or hosted MCP endpoint.
- CI validates source and packaging only. Publishing/deployment requires its own user authorization.
