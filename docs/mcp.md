# OmniaKey MCP

The server runs locally over **stdio**. It forwards authenticated requests to the existing OmniaKey HTTPS API; it does not expose a local HTTP port or a hosted MCP URL. Node.js 22+, npm and Git must be available to the application starting the server.

## Codex

Add this to `~/.codex/config.toml` (or the project's trusted Codex configuration):

```toml
[mcp_servers.omniakey]
command = "npx"
args = ["--yes", "github:omniakey-com/omniakey-devtools#v0.1.0", "mcp"]
env_vars = ["OMNIAKEY_API_KEY"]
```

Set `OMNIAKEY_API_KEY` in the environment of the Codex process, then restart/reload the connection. For a custom gateway, add `OMNIAKEY_BASE_URL` to `env_vars` as well. See [official Codex MCP configuration](https://developers.openai.com/codex/mcp/).

## Claude Code

After setting the key in the same terminal:

```bash
claude mcp add --transport stdio omniakey -- npx --yes github:omniakey-com/omniakey-devtools#v0.1.0 mcp
```

Restart Claude Code from that environment. The default registration scope is local to this project; choose a different scope through the client's own configuration when needed. Do not include the API key in the command arguments.

## Cursor and other JSON-configured clients

Add the server entry to your client's MCP configuration (for example, Cursor's project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "omniakey": {
      "command": "npx",
      "args": ["--yes", "github:omniakey-com/omniakey-devtools#v0.1.0", "mcp"]
    }
  }
}
```

Start the client with `OMNIAKEY_API_KEY` in its environment or configure it through the client's supported secret mechanism. A GUI opened from the Dock/Start menu may not inherit terminal variables. Do not commit a key into this JSON. On Windows, clients that cannot spawn `npx` directly can use `"command": "cmd"` with `"args": ["/c", "npx", ...]`.

For VS Code, use its `servers` configuration key instead of `mcpServers` and set `type` to `stdio`; use VS Code's password input variable for credentials. [VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) explains secret inputs.

## Tools

| Tool | Behavior |
| --- | --- |
| `omniakey_models` | Authenticated model discovery; optional substring and result limit |
| `omniakey_schema` | Offline common request envelope for chat/media plus documentation links |
| `omniakey_chat` | One paid non-streaming chat completion |
| `omniakey_submit_task` | One paid media submission with a required stable idempotency key |
| `omniakey_get_task` | Read status and fresh signed asset URLs |
| `omniakey_wait_task` | Poll the original id for at most 45 seconds per tool call |
| `omniakey_cancel_task` | Request cancellation, then inspect the returned state |

Read-only and mutating tools carry MCP annotations. Your client controls tool permissions; annotations are hints, not an authorization system. `failed` and `canceled` task responses carry `isError: true` together with the actual task state. Waiting timeouts carry `wait_timed_out: true`; this means resume, not success or cancellation.

Server initialization, tool listing and `omniakey_schema` work without credentials. `omniakey_models` and all API calls require a key. The MCP server does not read a browser session, store credentials, execute returned tool calls or download output URLs. Keep stdout reserved for JSON-RPC.

## First check

Ask your agent:

> List the OmniaKey tools, read the common media schema, and list the models available to my API key. Do not generate anything.

Missing key: check the environment of the *client process*. HTTP 401: check validity and key access. HTTP 403 or non-JSON: check the chosen API URL and edge access controls. On a submission timeout, retain the idempotency key. When an id is known, query it instead of submitting again.
