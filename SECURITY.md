# Security

Keep API keys in your process environment or client secret manager. Do not submit keys, prompts containing private data, or signed asset URLs in public issues. The tools never save keys and reject credential-bearing URLs, insecure non-loopback endpoints and HTTP redirects.

Models, task outputs and remote errors are untrusted data. The tools do not execute returned code or tool calls, fetch output assets, or expose an HTTP listener. Generation can incur charges under the API account's existing rules. Use a suitably scoped API key and your MCP client's tool permissions.

Report a suspected vulnerability privately to support@omniakey.com with a minimal reproduction and no credentials. Rotate a key through the dashboard if it has been exposed.
