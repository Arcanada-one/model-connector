// CONN-0243 — Zod schema for the OpenAI-compatible POST /v1/chat/completions body.
// Tolerant of unknown OpenAI fields (.passthrough) so SDK clients are not rejected
// for sending fields the gateway does not act on.

import { z } from 'zod';

const contentPartSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool', 'developer', 'function']),
    content: z
      .union([z.string(), z.array(contentPartSchema)])
      .nullable()
      .optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const openAiChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    stream: z.boolean().optional(),
    response_format: z.object({ type: z.string() }).passthrough().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type OpenAiChatCompletionRequest = z.infer<typeof openAiChatCompletionRequestSchema> & {
  // content normalised to the message shape the translator reads.
  messages: OpenAiChatMessage[];
};

export interface OpenAiChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  name?: string;
}
