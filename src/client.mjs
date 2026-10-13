import { setTimeout as delay } from 'node:timers/promises';
import { chatRequest, idempotencyKey, mediaRequest, taskId, taskResponse } from './contracts.mjs';

export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function errorInfo(error) {
  if (error?.name === 'ZodError') {
    return { code: 'invalid_input', message: error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ') };
  }
  return { code: error.code || 'error', message: error.message || 'Operation failed.', ...error.details };
}

export function normalizeBaseUrl(value = 'https://api.omniakey.com/v1') {
  let url;
  try { url = new URL(value); } catch { throw new ToolError('invalid_base_url', 'OMNIAKEY_BASE_URL must be an absolute HTTPS URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new ToolError('invalid_base_url', 'Use HTTPS without credentials, query or fragment; HTTP is allowed only on loopback for local development.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.toString().replace(/\/$/, '');
}

export function redact(value, apiKey) {
  if (!apiKey) return value;
  if (typeof value === 'string') return value.split(apiKey).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item, apiKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(apiKey).join('[REDACTED]'), redact(item, apiKey)]));
  return value;
}

export class OmniaKeyClient {
  constructor({ apiKey = process.env.OMNIAKEY_API_KEY, baseUrl = process.env.OMNIAKEY_BASE_URL, timeoutMs = 120_000 } = {}) {
    this.apiKey = apiKey?.trim();
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new ToolError('invalid_timeout', 'Request timeout must be between 1 and 300000 ms.');
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    if (!this.apiKey) throw new ToolError('missing_api_key', 'Set OMNIAKEY_API_KEY in the environment of the CLI or MCP client.');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > 1_048_576) throw new ToolError('input_too_large', 'Request JSON must be at most 1 MiB.');
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let response;
    let data;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.apiKey}`, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: payload,
        signal: requestSignal,
      });
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 8_388_608) throw new ToolError('response_too_large', 'API response exceeds 8 MiB.');
        chunks.push(chunk);
      }
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        throw new ToolError('invalid_response', `The gateway returned non-JSON (HTTP ${response.status}). Check the base URL and edge access rules.`, { status: response.status });
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (requestSignal.aborted) throw new ToolError('request_timeout', 'The request was interrupted or timed out. Its remote outcome may be unknown; do not repeat a paid request blindly.');
      throw new ToolError('network_error', 'Could not reach the API. Redirects are refused to protect credentials. A submitted request may still be running.');
    }
    if (!response.ok || (data?.error && !path.startsWith('/media/tasks')) || data?.success === false) {
      const upstream = data?.error;
      const message = typeof upstream?.message === 'string' ? upstream.message.slice(0,600) : 'The API rejected the request. Check your key, model access and account balance.';
      const code = typeof upstream?.code === 'string' ? upstream.code.slice(0,100) : `http_${response.status}`;
      throw new ToolError(code, redact(message, this.apiKey), { status: response.status });
    }
    return redact(data, this.apiKey);
  }

  async models({ search = '', limit = 50, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ToolError('invalid_limit', 'Limit must be an integer from 1 to 1000.');
    const result = await this.request('/models', { signal });
    if (!Array.isArray(result?.data) || result.data.some(m => typeof m?.id !== 'string')) throw new ToolError('invalid_response', 'Expected a model list from /v1/models.');
    const matches = result.data.filter(m => m.id.toLowerCase().includes(search.toLowerCase()));
    return { object: 'list', data: matches.slice(0, limit), total: matches.length, has_more: matches.length > limit };
  }

  async chat(input, { signal } = {}) {
    const result = await this.request('/chat/completions', { method: 'POST', body: { ...chatRequest.parse(input), stream: false }, signal });
    if (!result || !Array.isArray(result.choices) || result.choices.length === 0) throw new ToolError('invalid_response', 'Expected a non-streaming chat completion.');
    return result;
  }

  async submit(input, key, { signal } = {}) {
    const body = mediaRequest.parse(input);
    const stableKey = idempotencyKey.parse(key);
    try {
      const task = taskResponse.parse(await this.request('/media/tasks', { method: 'POST', body, headers: { 'Idempotency-Key': stableKey }, signal }));
      return { ...task, idempotency_key: stableKey };
    } catch (error) {
      const safe = errorInfo(error);
      throw new ToolError(safe.code, safe.message, { ...safe, idempotency_key: stableKey, recovery: 'For an uncertain submission, retry only the identical JSON with this same key. Do not create a new key.' });
    }
  }

  async getTask(id, { signal } = {}) {
    const parsedId = taskId.parse(id);
    const task = taskResponse.parse(await this.request(`/media/tasks/${encodeURIComponent(parsedId)}`, { signal }));
    if (task.id !== parsedId) throw new ToolError('invalid_response', 'The gateway returned a different task id.');
    return task;
  }

  async cancelTask(id, { signal } = {}) {
    const parsedId = taskId.parse(id);
    const task = taskResponse.parse(await this.request(`/media/tasks/${encodeURIComponent(parsedId)}/cancel`, { method: 'POST', signal }));
    if (task.id !== parsedId) throw new ToolError('invalid_response', 'The gateway returned a different task id.');
    return task;
  }

  async waitTask(id, { timeoutSeconds = 90, intervalSeconds = 3, signal } = {}) {
    const parsedId = taskId.parse(id);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 || !Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60) {
      throw new ToolError('invalid_wait', 'Wait timeout must be 1–3600 seconds; interval must be 1–60 seconds.');
    }
    const deadline = AbortSignal.timeout(Math.round(timeoutSeconds * 1000));
    const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let lastTask;
    try {
      while (!combined.aborted) {
        lastTask = await this.getTask(parsedId, { signal: combined });
        if (['succeeded', 'failed', 'canceled'].includes(lastTask.status)) return { ...lastTask, wait_timed_out: false };
        await delay(intervalSeconds * 1000, undefined, { signal: combined });
      }
    } catch (error) {
      if (!combined.aborted) {
        const info = errorInfo(error);
        throw new ToolError(info.code, info.message, { ...info, task_id: parsedId, recovery: 'Resume task get or task wait with this task id; do not submit again.' });
      }
    }
    return { ...(lastTask ?? { id: parsedId }), wait_timed_out: true, interrupted: !!signal?.aborted, recovery: 'Local waiting stopped. The remote task was not canceled. Resume task get or task wait with this id.' };
  }
}
