# OmniaKey developer tools

Use **OmniaKey** from your terminal or coding agent: discover accessible models, request text completions, and submit, resume or cancel image, video and audio tasks.

One package contains a CLI, a local [MCP server](docs/mcp.md) and an [Agent Skill](skills/omniakey-models/SKILL.md). They call the same public API with your API key. No additional service or account is required.

## Start in a terminal

Requires **Node.js 22+**, npm and Git. Run the tagged source directly from GitHub:

```bash
npx --yes github:omniakey-com/omniakey-devtools#v0.1.0 help
```

Or install the same version globally:

```bash
npm install --global github:omniakey-com/omniakey-devtools#v0.1.0
omniakey help
```

This release is distributed through GitHub; it does not require an npm registry publication. Pin the tag in scripts and MCP configurations.

Create a key at [API keys](https://omniakey.com/dashboard/tokens). Load it into your terminal environment without putting it in command history (Bash / zsh):

```bash
read -s OMNIAKEY_API_KEY
export OMNIAKEY_API_KEY
```

Paste the key at the hidden prompt and press Enter. In PowerShell:

```powershell
$env:OMNIAKEY_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OmniaKey API key' -AsSecureString)).Password
```

The CLI only reads the key from the environment. It does not save credentials or offer a `--api-key` argument. The default URL is `https://api.omniakey.com/v1`; set `OMNIAKEY_BASE_URL` to an explicitly chosen compatible gateway if needed. HTTPS is required except for loopback development. Redirects are refused.

Discover accessible IDs, then read the [model documentation](https://omniakey.com/models) and [current prices](https://omniakey.com/pricing):

```bash
omniakey models --search gpt --limit 20
omniakey schema chat
omniakey schema media
```

`models` is authenticated and does not generate content. `schema` works offline and returns the **common request envelope**, not a model-specific capability or pricing catalog. Availability, operations and supported parameters depend on the selected model and account. Do not infer support from its name.

## Generate text

The following is a paid request; replace the model with an accessible chat model:

```bash
omniakey chat --model YOUR_CHAT_MODEL --prompt "Write a one-sentence product description."
```

For multimodal messages and advanced parameters, use `omniakey chat --file chat.json`. The file contains an OpenAI-compatible `model` and `messages` request. Responses are non-streaming JSON, including provider usage when returned. Tool calls are returned as data; this package never executes them.

## Submit once, resume by id

The [image example](examples/image.json) uses the canonical GPT-Image 2 envelope. Review that model's current availability and price before running it:

```bash
omniakey submit --file examples/image.json --idempotency-key YOUR_UNIQUE_TASK_KEY
omniakey task get TASK_ID
omniakey task wait TASK_ID --timeout 300 --interval 3
omniakey task cancel TASK_ID
```

Choose a unique key for each *intended* generation. Save both the key and returned **`id`**. If submission times out, retry only the identical JSON with that same key; the API can then return the existing task. Changed input with a reused key returns a conflict. Neither CLI nor MCP automatically repeats an HTTP request.

`omniakey run --file examples/image.json --idempotency-key YOUR_UNIQUE_TASK_KEY` submits and waits up to 90 seconds. It immediately writes the task id and key to stderr, then writes the result to stdout. A local timeout stops waiting; it does **not** cancel or recreate the remote task. Continue with `task get` or `task wait` and the same id.

Public states are `queued`, `processing`, `succeeded`, `failed`, and `canceled`. Successful media output uses `assets[].url`; signed URLs expire, so query the task again for fresh URLs. The tools return URLs without automatically downloading remote files. Cancellation can remain `processing`; check status to confirm the outcome. Billing, settlement and refund rules remain owned by the API; the tools do not calculate or promise a charge.

All command results are JSON on stdout. Errors are `{ "error": { "code", "message", ... } }`. `--file -` reads JSON from stdin. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Request completed; submit may still be queued |
| 1 | Invalid input, authentication, network or API error |
| 2 | Returned task is failed or canceled |
| 3 | Waiting ended; preserve the id and check again |

## Connect an agent

Configure the [MCP server](docs/mcp.md), then install the Skill in the current project:

```bash
npx skills add omniakey-com/omniakey-devtools --skill omniakey-models
```

Choose your agent in the installer, then reload it. Use `--agent codex` or `--agent claude-code` to select a client; add `--global` only when you want it available across projects. The skill installer follows the repository's current branch; CLI/MCP commands in this release pin `v0.1.0`.

Read-only verification prompt:

> Use the omniakey-models Skill. Confirm whether OmniaKey MCP or CLI is available, list accessible models, and explain the common media request envelope. Do not submit a generation task.

The Skill teaches discovery, model-specific documentation checks, idempotency, task recovery and accurate results. It is useful alongside MCP or CLI; installing it alone does not configure credentials or connect an API.

## Development and validation

```bash
npm ci
npm run check
npm pack --dry-run
```

Integration tests use a local HTTP server and a real MCP stdio client. They cover authenticated routing, JSON payloads, strict input, terminal states, timeouts, idempotency propagation, credential redaction and redirect refusal. No real API key or paid generation is required. These tests establish client/protocol behavior, not the availability of a particular live model.

See [architecture](docs/architecture.md), [security](SECURITY.md) and [MIT license](LICENSE).
