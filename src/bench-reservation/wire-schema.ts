import { z } from "zod";

const textContent = z
  .object({ type: z.enum(["input_text", "output_text"]), text: z.string() })
  .strict();
const message = z
  .object({
    type: z.literal("message").optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(textContent)]),
  })
  .strict();
const input = z.union([z.string(), z.array(message)]);
/** This is an admissible text-only source schema, not a measured provider token
 * bound. Unknown input variants refuse; original corpus may not be truncated. */
export const wireSchema = z
  .object({
    model: z.literal("gpt-6-luna"),
    input,
    instructions: z.string().optional(),
    tools: z.array(z.never()).optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional(),
        summary: z.enum(["auto", "concise", "detailed"]).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    store: z.literal(false).optional(),
    stream: z.literal(true).optional(),
    stream_options: z
      .object({ include_usage: z.boolean() })
      .strict()
      .optional(),
    include: z.array(z.literal("reasoning.encrypted_content")).optional(),
    service_tier: z.literal("auto").optional(),
    prompt_cache_key: z.string().optional(),
    text: z
      .object({
        verbosity: z.enum(["low", "medium", "high"]).optional(),
        format: z
          .object({
            type: z.enum(["text", "json_schema"]),
            strict: z.boolean().optional(),
            schema: z.record(z.string(), z.unknown()).optional(),
            name: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    client_metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
