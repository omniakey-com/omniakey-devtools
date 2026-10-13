# Architecture and scope

CLI and MCP -> shared client -> `https://api.omniakey.com/v1` -> existing OmniaKey gateway.

The Skill is an operating guide, not an additional runtime. The public website documents installation; it does not receive user API keys or run these tools in the browser.

| Operation | Existing API |
| --- | --- |
| Model discovery | `GET /v1/models` |
| Text | `POST /v1/chat/completions`, `stream: false` |
| Media submission | `POST /v1/media/tasks`, required `Idempotency-Key` |
| Task status/assets | `GET /v1/media/tasks/{id}` |
| Cancel | `POST /v1/media/tasks/{id}/cancel` |

The API owns authentication, model access, channel selection, billing, queues and task storage. This package holds no database, local credential store, browser session or service credential. It creates no API keys and has no dependency on the web authentication migration. Model-specific schema, availability and pricing remain in product documentation and the gateway; the offline `schema` command describes only the common envelope.

Both transports use `src/client.mjs`, and Zod contracts in `src/contracts.mjs` validate input. Responses are bounded to 8 MiB, requests to 1 MiB, network calls to 120 seconds and polling to an explicit deadline. Mutations are never automatically retried. HTTP redirect handling is disabled to avoid sending credentials to a redirected host. Gateway errors preserve status and error codes without dumping non-JSON edge responses or credentials.

A media submit returns `id`, not `task_id`. The CLI adds `idempotency_key` for recovery. A task's `failed` response can contain an `error` object even with HTTP 200; it remains a terminal task result. `expires_at` and signed asset URLs are returned as received. The package never claims a task completed because a local timer elapsed.

CI tests use local fixtures; they neither deploy infrastructure nor submit real paid requests. Source distribution uses a GitHub tag with the npm lockfile; there is no automatic npm publishing workflow. The website can be reviewed and merged independently after the source tag exists.
