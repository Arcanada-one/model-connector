/** reuse: Zod closed DTOs and billing intentPayloadFingerprint; no legacy DTO changes. */
import { z } from 'zod';
import { intentPayloadFingerprint } from '../../billing/intent';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().max(262144);
const fn = z.object({ name: id, arguments: text }).strict();
const call = z.object({ id, type: z.literal('function'), function: fn }).strict();
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: text }).strict(),
  z.object({ role: z.literal('user'), content: text }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: text.nullable(),
      reasoning_content: text.optional(),
      tool_calls: z.array(call).min(1).max(32).optional(),
    })
    .strict(),
  z.object({ role: z.literal('tool'), content: text, tool_call_id: id }).strict(),
]);
export const strictChatSchema = z
  .object({
    version: z.literal('mc-chat/v1'),
    intent: id,
    attempt: id,
    generation: z.string().regex(/^[1-9][0-9]{0,18}$/u),
    model: id,
    capability_sha256: hash,
    admission_sha256: hash,
    rate_sha256: hash,
    checkpoint_sha256: hash,
    deadline_ms: z.number().int().safe().positive(),
    messages: z.array(message).min(1).max(128),
    tools: z
      .array(
        z
          .object({
            type: z.literal('function'),
            function: z
              .object({
                name: id,
                description: z.string().max(8192).optional(),
                parameters: z.record(z.string(), z.unknown()),
              })
              .strict(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    tool_choice: z.enum(['auto', 'none']).optional(),
    parallel_tool_calls: z.literal(false),
    thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict(),
    reasoning_effort: z.enum(['low', 'high', 'max']).optional(),
    stream: z.literal(true),
    stream_options: z.object({ include_usage: z.literal(true) }).strict(),
    max_tokens: z.number().int().min(1).max(1048576),
    input_token_bound: z.number().int().safe().positive(),
    output_byte_bound: z.number().int().min(1).max(8388608),
  })
  .strict();
export type StrictChatRequest = z.infer<typeof strictChatSchema>;
export function parseStrictChat(value: unknown): StrictChatRequest {
  // Bound serialized payload before expensive validation; refuse, never truncate.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8388608)
    throw new Error('chat-body-refused');
  const body = strictChatSchema.parse(value);
  if (BigInt(body.generation) > 9223372036854775807n) throw new Error('chat-generation-refused');
  const names = new Set(body.tools?.map((t) => t.function.name) ?? []);
  if (names.size !== (body.tools?.length ?? 0)) throw new Error('chat-tools-refused');
  const seen = new Set<string>(),
    pending = new Set<string>();
  for (const m of body.messages) {
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) throw new Error('chat-tool-order-refused');
    } else {
      if (pending.size) throw new Error('chat-tool-results-missing');
      if (m.role === 'assistant') {
        if (m.content === null && !m.tool_calls) throw new Error('chat-empty-assistant-refused');
        if (
          body.thinking.type === 'enabled' &&
          body.tools?.length &&
          m.reasoning_content === undefined
        )
          throw new Error('chat-continuation-missing');
        for (const c of m.tool_calls ?? []) {
          if (seen.has(c.id) || !names.has(c.function.name))
            throw new Error('chat-tool-binding-refused');
          JSON.parse(c.function.arguments);
          seen.add(c.id);
          pending.add(c.id);
        }
      }
    }
  }
  if (pending.size || !body.messages.some((m) => m.role === 'user'))
    throw new Error('chat-conversation-refused');
  return body;
}
export function chatDigest(connector: string, body: StrictChatRequest): string {
  return intentPayloadFingerprint({ connector, body });
}
export function providerBody(body: StrictChatRequest) {
  return {
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
    stream: body.stream,
    stream_options: body.stream_options,
    max_tokens: body.max_tokens,
  };
}
