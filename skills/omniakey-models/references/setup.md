# Choose one execution path

Node.js 22+, npm and Git are required for the local package. The current source release is installable without an npm publication:

```bash
npx --yes github:omniakey-com/omniakey-devtools#v0.1.0 help
```

All CLI commands can use that prefix, or install globally with `npm install --global github:omniakey-com/omniakey-devtools#v0.1.0` and use `omniakey`.

The default API base is `https://api.omniakey.com/v1`. The CLI reads `OMNIAKEY_API_KEY`; a custom gateway can be supplied through `OMNIAKEY_BASE_URL`. Neither value should be silently changed when a user has configured a destination.

For MCP, follow <https://github.com/omniakey-com/omniakey-devtools/blob/v0.1.0/docs/mcp.md>. It runs the same package with `mcp` over stdio. Client configuration differs across Codex, Claude Code, Cursor and VS Code. Use the documented client-specific configuration rather than inventing a hosted URL or copying secret values into repository files.

After setup, discover tools, read the common schema and list models. These checks do not submit paid generation. Missing key or edge rejection is a setup failure; do not treat it as evidence a model is unavailable. General provider configuration belongs to the separate <https://github.com/omniakey-com/ai-agent-api-setup> project.
