#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { OmniaKeyClient, ToolError, errorInfo, redact } from '../src/client.mjs';
import { schemaFor } from '../src/contracts.mjs';

const help = `OmniaKey developer tools 0.1.0 (Node.js 22+)

Usage:
  omniakey models [--search TEXT] [--limit 50]
  omniakey schema chat|media
  omniakey chat --model MODEL --prompt TEXT
  omniakey chat --file request.json
  omniakey submit --file request.json --idempotency-key KEY
  omniakey run --file request.json --idempotency-key KEY [--timeout 90]
  omniakey task get ID
  omniakey task wait ID [--timeout 90] [--interval 3]
  omniakey task cancel ID
  omniakey mcp
  omniakey help

Use --file - to read JSON from stdin. All results are JSON on stdout.
Set OMNIAKEY_API_KEY in your environment; no key is stored on disk.
OMNIAKEY_BASE_URL defaults to https://api.omniakey.com/v1.
models and task get/wait are read-only; schema works offline.
chat, submit and run can incur charges. task cancel requests cancellation.
No automatic request retries. Preserve each task id and idempotency key.
Exit codes: 0 success, 1 request/input error, 2 failed/canceled task,
3 wait timeout (task still exists). MCP reserves stdout for JSON-RPC.
`;

function options(args, spec = {}) {
  const parsed = parseArgs({ args, options: spec, strict: true, allowPositionals: false });
  return parsed.values;
}
const string = { type: 'string' };

async function readJson(file) {
  if (!file) throw new ToolError('missing_file', 'Pass --file request.json or --file - for stdin.');
  let bytes;
  if (file === '-') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1_048_576) throw new ToolError('input_too_large', 'Input JSON must be at most 1 MiB.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    if ((await stat(file)).size > 1_048_576) throw new ToolError('input_too_large', 'Input JSON must be at most 1 MiB.');
    bytes = await readFile(file);
  }
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ToolError('invalid_json', 'Input must be a valid JSON object.'); }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(redact(value, process.env.OMNIAKEY_API_KEY?.trim()), null, 2)}\n`);
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (command === '--version') { process.stdout.write('0.1.0\n'); return; }
  if (command === 'mcp') { options(args); const { startMcp } = await import('../src/mcp.mjs'); await startMcp(); return; }
  if (command === 'schema') { const [kind, ...rest] = args; options(rest); output(schemaFor(kind)); return; }
  const client = new OmniaKeyClient();
  let result;
  if (command === 'models') {
    const o = options(args, { search: string, limit: string });
    result = await client.models({ search: o.search, limit: o.limit === undefined ? 50 : Number(o.limit) });
  } else if (command === 'chat') {
    const o = options(args, { model: string, prompt: string, file: string });
    if (o.file && (o.model !== undefined || o.prompt !== undefined)) throw new ToolError('invalid_input', 'Use either --file or --model with --prompt.');
    if (!o.file && (!o.model || !o.prompt)) throw new ToolError('invalid_input', 'chat requires --model and --prompt, or --file.');
    result = await client.chat(o.file ? await readJson(o.file) : { model: o.model, messages: [{ role: 'user', content: o.prompt }] });
  } else if (command === 'submit' || command === 'run') {
    const o = options(args, { file: string, 'idempotency-key': string, ...(command === 'run' ? { timeout: string, interval: string } : {}) });
    const timeoutSeconds = Number(o.timeout ?? 90);
    const intervalSeconds = Number(o.interval ?? 3);
    if (command === 'run' && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 || !Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60)) throw new ToolError('invalid_wait', 'Wait timeout must be 1–3600 seconds; interval must be 1–60 seconds.');
    result = await client.submit(await readJson(o.file), o['idempotency-key']);
    if (command === 'run') {
      process.stderr.write(`${JSON.stringify({ task_id: result.id, idempotency_key: result.idempotency_key })}\n`);
      result = { ...await client.waitTask(result.id, { timeoutSeconds, intervalSeconds }), idempotency_key: result.idempotency_key };
    }
  } else if (command === 'task') {
    const [action, id, ...rest] = args;
    const o = options(rest, action === 'wait' ? { timeout: string, interval: string } : {});
    if (action === 'get') result = await client.getTask(id);
    else if (action === 'cancel') result = await client.cancelTask(id);
    else if (action === 'wait') result = await client.waitTask(id, { timeoutSeconds: Number(o.timeout ?? 90), intervalSeconds: Number(o.interval ?? 3) });
    else throw new ToolError('invalid_command', 'Use task get, task wait or task cancel.');
  } else throw new ToolError('invalid_command', 'Unknown command. Run omniakey help.');
  output(result);
  process.exitCode = result.wait_timed_out ? 3 : ['failed', 'canceled'].includes(result.status) ? 2 : 0;
}

main().catch(error => {
  if (process.argv[2] === 'mcp') process.stderr.write(`${JSON.stringify(redact({ error: errorInfo(error) }, process.env.OMNIAKEY_API_KEY?.trim()))}\n`);
  else output({ error: errorInfo(error) });
  process.exitCode = 1;
});
