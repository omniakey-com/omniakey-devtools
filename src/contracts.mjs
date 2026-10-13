import { z } from 'zod';

export const modelId = z.string().trim().min(1).max(256);
export const taskId = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/, 'Use the task id returned by submit.');
export const idempotencyKey = z.string().regex(/^[\x21-\x7e]{1,255}$/, 'Use 1–255 printable ASCII characters without spaces.');
export const jsonObject = z.record(z.string(), z.unknown());

// Model-specific input and parameter validation stays with the gateway.
export const mediaRequest = z.object({
  model: modelId,
  type: z.enum(['image', 'video', 'audio']),
  operation: z.string().trim().min(1).max(80),
  input: jsonObject,
  parameters: jsonObject.optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();

export const chatRequest = z.object({
  model: modelId,
  messages: z.array(z.object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(jsonObject), z.null()]).optional(),
  }).passthrough()).min(1),
  stream: z.literal(false).optional(),
}).passthrough();

export const taskResponse = z.object({
  id: taskId,
  status: z.enum(['queued', 'processing', 'succeeded', 'failed', 'canceled']),
}).passthrough();

export function schemaFor(kind) {
  if (!['chat', 'media'].includes(kind)) throw new Error('Schema must be chat or media.');
  return {
    kind,
    endpoint: kind === 'chat' ? 'POST /v1/chat/completions' : 'POST /v1/media/tasks',
    schema: z.toJSONSchema(kind === 'chat' ? chatRequest : mediaRequest),
    ...(kind === 'media' ? { headers: { 'Idempotency-Key': 'Required: one stable key per intended task.' } } : {}),
    note: 'Common request envelope only. Check model-specific inputs, operations and current prices in the model documentation before execution. A model listing does not guarantee every protocol or operation.',
    models_url: 'https://omniakey.com/models',
    pricing_url: 'https://omniakey.com/pricing',
    docs_url: 'https://docs.omniakey.com/en/introduction',
  };
}
