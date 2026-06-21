import { z } from 'zod';

// ─── Text connector DTO (existing) ────────────────────────────────────────────

export const OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT = 32_768;

// ARCA-0011 — ContentBlock union for multi-modal prompts.
// Mirrors Anthropic / OpenRouter content-block shape; only data: URLs accepted
// for image_url to avoid logging or forwarding remote URLs from untrusted
// callers (Telegram CDN URLs are short-lived + unsigned).
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(100_000),
  }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().regex(/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// Base shape WITHOUT refinement — refinement is attached after `.omit()` so the
// per-connector variant can be derived (Zod v4 forbids omit on refined schemas).
const executeRequestBaseShape = {
  connector: z.string().min(1).max(50).optional(),
  prompt: z.union([z.string().min(1).max(100_000), z.array(ContentBlockSchema).min(1).max(20)]),
  model: z.string().max(100).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  tools: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxBudgetUsd: z.number().min(0).max(100).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  responseFormat: z.object({ type: z.enum(['json_object', 'text']) }).optional(),
  timeout: z.number().int().min(5_000).max(600_000).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  // CONN-0223 — cascade profile: mutually exclusive with connector.
  profile: z.enum(['low-reasoning']).optional(),
  // CONN-0089 output-guard: opt-in structured-output validate-and-repair
  output_format: z.enum(['json', 'yaml', 'toml', 'python', 'auto']).optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
} as const;

const schemaSizeRefine = (
  val: { schema?: unknown },
  ctx: {
    addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void;
  },
): void => {
  if (val.schema !== undefined) {
    const size = JSON.stringify(val.schema).length;
    if (size > OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        path: ['schema'],
        message: `schema exceeds ${OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT}-byte limit (got ${size} bytes)`,
      });
    }
  }
};

export const executeRequestSchema = z
  .object(executeRequestBaseShape)
  .superRefine(schemaSizeRefine)
  .superRefine((val, ctx) => {
    const hasConnector = val.connector != null && val.connector !== '';
    const hasProfile = val.profile != null;
    if (!hasConnector && !hasProfile) {
      ctx.addIssue({
        code: 'custom',
        path: ['connector'],
        message: 'Exactly one of connector or profile is required',
      });
    }
    if (hasConnector && hasProfile) {
      ctx.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'connector and profile are mutually exclusive',
      });
    }
  });

export type ExecuteRequestDto = z.infer<typeof executeRequestSchema>;

const { connector: _connectorOmitted, ...perConnectorBaseShape } = executeRequestBaseShape;
export const perConnectorExecuteSchema = z
  .object(perConnectorBaseShape)
  .superRefine(schemaSizeRefine);
export type PerConnectorExecuteDto = z.infer<typeof perConnectorExecuteSchema>;

// ─── Image generation DTO ─────────────────────────────────────────────────────

export const imageGenerateRequestSchema = z.object({
  tier: z.enum(['cheap', 'mid', 'premium']).default('mid'),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  aspectRatio: z
    .enum(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '2:3', '3:2', '5:4', '4:5'])
    .optional(),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  count: z.number().int().min(1).max(4).default(1),
  seed: z.number().int().optional(),
  outputFormat: z.enum(['url', 'inline_base64']).default('url'),
  outputAsync: z.enum(['auto', 'force', 'never']).default('auto'),
  maxBudgetUsd: z.number().gt(0).max(100).optional(),
  model: z.string().max(100).optional(),
});

export type ImageGenerateRequestDto = z.infer<typeof imageGenerateRequestSchema>;
