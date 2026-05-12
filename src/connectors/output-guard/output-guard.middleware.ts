// CONN-0089 — Output guard middleware.
//
// Sits between `ConnectorsService.execute()` and `connector.execute()` when the
// request carries `output_format`. Validates + repairs the connector's
// `result` text through `@arcanada/output-guard`, with bounded retries that
// build a correction prompt via the library's `retryPrompt` helper.
//
// Contract surface (consumed by ConnectorsService):
//   const guarded = await middleware.wrapExecute(connector, request, runtime);
//   guarded.response → ConnectorResponse (mutated `result`/`structured` on success,
//                       or `error.type='guard_exhausted'` on failure)
//   guarded.report   → OutputGuardReport (for HTTP body + Prisma column)
//   guarded.bypassed → true when guard was disabled or output_format absent
//
// Library outcome translation (see types.ts):
//   first-attempt validation pass + zero strategies + supportsJsonSchema → 'native'
//   library repaired successfully (pass A or B, any attempt 1..N)         → 'guarded'
//   MAX_RETRIES exhausted (ParseError or schema-rejection on last try)    → 'failed'

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ParseError, SchemaValidationError, repair, retryPrompt } from '@arcanada/output-guard';
import type { Format } from '@arcanada/output-guard';

import type {
  ConnectorRequest,
  ConnectorResponse,
  IConnector,
} from '../interfaces/connector.interface';
import type { ExecuteRequestDto } from '../dto/execute.dto';
import { buildAjvAdapter, type JsonSchema, type SchemaValidator } from './ajv-adapter';
import { pickInjector } from './schema-injectors';
import type { OutputGuardPass, OutputGuardReport } from './types';

export interface OutputGuardRuntimeConfig {
  enabled: boolean;
  maxRetries: number;
  timeoutMs: number;
}

export const OUTPUT_GUARD_CONFIG = Symbol('OUTPUT_GUARD_CONFIG');

export interface GuardedExecuteOutcome {
  response: ConnectorResponse;
  report: OutputGuardReport | null;
  bypassed: boolean;
}

@Injectable()
export class OutputGuardMiddleware {
  private readonly logger = new Logger(OutputGuardMiddleware.name);

  constructor(
    @Optional() @Inject(OUTPUT_GUARD_CONFIG) private readonly config?: OutputGuardRuntimeConfig,
  ) {}

  private cfg(): OutputGuardRuntimeConfig {
    return this.config ?? { enabled: true, maxRetries: 3, timeoutMs: 30_000 };
  }

  /**
   * Run the guard pipeline. Pure on the input request (deep clones via spread
   * when injecting). Idempotent on connector error responses — they pass
   * through unmodified so the outer service retry loop owns retry semantics
   * for transport-level failures.
   */
  async wrapExecute(
    connector: IConnector,
    request: ConnectorRequest & Partial<Pick<ExecuteRequestDto, 'output_format' | 'schema'>>,
  ): Promise<GuardedExecuteOutcome> {
    const cfg = this.cfg();
    const outputFormat = request.output_format;

    if (!cfg.enabled || !outputFormat) {
      const response = await connector.execute(stripGuardFields(request));
      return { response, report: null, bypassed: true };
    }

    const schema = request.schema as JsonSchema | undefined;
    let validator: SchemaValidator | undefined;
    if (schema) {
      try {
        validator = buildAjvAdapter(schema);
      } catch (err) {
        return {
          response: this.buildSchemaCompileError(connector, request, err),
          report: {
            strategies_applied: [],
            retries: 0,
            final_valid: false,
            pass: 'failed',
            error: errMessage(err),
          },
          bypassed: false,
        };
      }
    }

    const capabilities = connector.getCapabilities();
    const injector = pickInjector(capabilities);
    let modifiedRequest = injector.inject(stripGuardFields(request), schema);

    const maxRetries = Math.max(0, cfg.maxRetries);
    const totalAttempts = maxRetries + 1;

    let lastResponse: ConnectorResponse | undefined;
    let strategiesApplied: string[] = [];
    let pass: OutputGuardPass = 'failed';
    let lastError: string | undefined;
    let attemptsUsed = 0;
    let succeeded = false;
    let repairedText: string | undefined;
    let parsedValue: unknown | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      attemptsUsed = attempt;
      const response = await connector.execute(modifiedRequest);
      lastResponse = response;

      if (response.status !== 'success') {
        // Transport-level failure — let outer retry loop own this.
        return { response, report: null, bypassed: false };
      }

      const outcome = this.attemptValidate(response.result, outputFormat, validator);
      strategiesApplied = outcome.strategiesApplied;
      lastError = outcome.error;

      if (outcome.valid) {
        succeeded = true;
        repairedText = outcome.text;
        parsedValue = outcome.data;
        if (
          attempt === 1 &&
          outcome.strategiesApplied.length === 0 &&
          capabilities.supportsJsonSchema
        ) {
          pass = 'native';
        } else {
          pass = 'guarded';
        }
        break;
      }

      if (attempt < totalAttempts) {
        const correction = retryPrompt({
          previousResponse: response.result,
          schema: schema ? JSON.stringify(schema) : undefined,
          errors: outcome.error ? [outcome.error] : undefined,
        });
        modifiedRequest = { ...modifiedRequest, prompt: correction.prompt };
      }
    }

    const retries = Math.max(0, attemptsUsed - 1);
    const report: OutputGuardReport = {
      strategies_applied: strategiesApplied,
      retries,
      final_valid: succeeded,
      pass,
      ...(succeeded ? {} : { error: lastError ?? 'guard repair retries exhausted' }),
    };

    if (!lastResponse) {
      // Defensive — only possible if maxRetries < 0, which Zod blocks.
      throw new Error('OutputGuardMiddleware produced no response');
    }

    if (succeeded) {
      lastResponse.result = repairedText ?? lastResponse.result;
      lastResponse.structured = parsedValue;
    } else {
      lastResponse.status = 'error';
      lastResponse.error = {
        type: 'guard_exhausted',
        message: report.error ?? 'guard repair retries exhausted',
        retryable: false,
        recommendation: 'abort',
      };
    }

    return { response: lastResponse, report, bypassed: false };
  }

  private attemptValidate(
    text: string,
    format: Format,
    validator: SchemaValidator | undefined,
  ): {
    valid: boolean;
    text: string;
    data?: unknown;
    strategiesApplied: string[];
    error?: string;
  } {
    try {
      const result = repair(text, format, validator);
      return {
        valid: true,
        text: result.repaired ? result.raw : text,
        data: result.data,
        strategiesApplied: [...result.strategiesApplied],
      };
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        return {
          valid: false,
          text,
          strategiesApplied: [],
          error: err.issues.length ? err.issues.join('; ') : err.message,
        };
      }
      if (err instanceof ParseError) {
        return { valid: false, text, strategiesApplied: [], error: err.message };
      }
      this.logger.warn(`output-guard validate threw unexpected: ${errMessage(err)}`);
      return { valid: false, text, strategiesApplied: [], error: errMessage(err) };
    }
  }

  private buildSchemaCompileError(
    connector: IConnector,
    request: ConnectorRequest,
    err: unknown,
  ): ConnectorResponse {
    return {
      id: `guard-schema-error-${Date.now()}`,
      connector: connector.name,
      model: request.model ?? '',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      status: 'error',
      error: {
        type: 'validation_error',
        message: `output_format schema rejected: ${errMessage(err)}`,
        retryable: false,
        recommendation: 'abort',
      },
    };
  }
}

function stripGuardFields(
  request: ConnectorRequest & { output_format?: unknown; schema?: unknown },
): ConnectorRequest {
  // Guard-only DTO fields MUST NOT leak into the downstream connector contract.
  const {
    output_format: _of,
    schema: _sc,
    ...rest
  } = request as ConnectorRequest & {
    output_format?: unknown;
    schema?: unknown;
  };
  return rest;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
