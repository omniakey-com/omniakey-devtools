# Architecture and scope

CLI / local stdio MCP -> shared client -> `https://api.omniakey.com/v1` -> existing OmniaKey gateway.

Remote MCP client -> OAuth + Streamable HTTP at `mcp.omniakey.com` -> per-key Durable Object guard -> shared client -> the same public API.

The Skill is an operating guide, not an additional runtime. The main website documents installation. The remote MCP domain hosts authorization and connection management forms; it does not share the main website's session.

| Operation | Existing API |
| --- | --- |
| Model discovery | `GET /v1/models` |
| Text | `POST /v1/chat/completions`, `stream: false` |
| Media submission | `POST /v1/media/tasks`, required `Idempotency-Key` |
| Task status/assets | `GET /v1/media/tasks/{id}` |
| Cancel | `POST /v1/media/tasks/{id}/cancel` |
| Remote key policy verification | `GET /v1/dashboard/billing/subscription` |

The API owns model access, channel selection, billing, queues and task storage. Local tools have no credential store. The remote Worker uses dedicated OAuth KV (encrypted key props, hashed tokens, client/grant metadata) and SQLite Durable Objects (connection IDs, expiry, revocation, counters and leases). It has no access to product databases, product sessions or internal service credentials. It creates no API keys and has no dependency on the web authentication migration. Model-specific schema, availability and pricing remain in product documentation and the gateway; the offline `schema` command describes only the common envelope.

Both transports use `src/client.mjs`, and Zod contracts in `src/contracts.mjs` validate input. Responses are bounded to 8 MiB, requests to 1 MiB, network calls to 120 seconds and polling to an explicit deadline. Mutations are never automatically retried. HTTP redirect handling is disabled to avoid sending credentials to a redirected host. Gateway errors preserve status and error codes without dumping non-JSON edge responses or credentials.

A media submit returns `id`, not `task_id`. The CLI adds `idempotency_key` for recovery. A task's `failed` response can contain an `error` object even with HTTP 200; it remains a terminal task result. `expires_at` and signed asset URLs are returned as received. The package never claims a task completed because a local timer elapsed.

CI tests use local fixtures; they neither deploy infrastructure nor submit real paid requests. Source distribution uses a GitHub tag with the npm lockfile; there is no automatic npm publishing or Worker deployment workflow. See [remote MCP operations](remote-mcp.md) for the explicit deployment and verification procedure.
