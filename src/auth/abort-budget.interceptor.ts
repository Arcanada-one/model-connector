import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { KeyRateLimitService } from './key-rate-limit.service';

interface RateLimitedRequest {
  apiKey?: { id: string };
}

/**
 * A2-301 / DEC-AUP-0050 R7 (b) — feeds the ABORT budget.
 *
 * What counts as an aborted attempt is not invented here: `base-api.connector.ts`
 * already sets `status: 'timeout'` exactly on the `isAbort` branch
 * (`base-api.connector.ts:617`, predicate in `src/core/utils/abort.ts:26`), i.e.
 * after the deadline cut a `fetch` that the provider had already been paid to
 * serve. `circuit_open` and `queue_timeout` return from branches ABOVE that
 * fetch (A2-299 R4) and carry `status: 'error'`, so they are correctly NOT
 * counted here — refusing before dispatch costs us nothing.
 *
 * Reading the OUTCOME rather than an internal hook is deliberate: it makes this
 * independent of the unmerged PR #151, which changes the cost accounting on that
 * same branch but leaves `status: 'timeout'` exactly where it is.
 *
 * Both paths are handled because a timeout is RETURNED (HTTP 200) today —
 * `'timeout'` is absent from `HTTP_ERROR_STATUS` in `connectors.controller.ts`,
 * so `mapResponseStatus` does not throw for it. If that map ever gains a
 * `timeout` entry, the `catchError` branch keeps the budget fed instead of
 * silently emptying it.
 */
@Injectable()
export class AbortBudgetInterceptor implements NestInterceptor {
  constructor(private readonly rateLimit: KeyRateLimitService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const keyId = context.switchToHttp().getRequest<RateLimitedRequest>().apiKey?.id;
    if (!keyId) return next.handle();

    return next.handle().pipe(
      mergeMap(async (value) => {
        if (isAbortOutcome(value)) await this.rateLimit.recordAbort(keyId);
        return value;
      }),
      catchError((err: unknown) => {
        if (err instanceof HttpException && isAbortOutcome(err.getResponse())) {
          // `recordAbort` never rejects, so the original error is always what
          // reaches the caller — the budget is bookkeeping, not a new failure.
          return from(this.rateLimit.recordAbort(keyId)).pipe(
            mergeMap(() => throwError(() => err)),
          );
        }
        return throwError(() => err);
      }),
    );
  }
}

/** A `ConnectorResponse` whose attempt was aborted mid-flight. */
function isAbortOutcome(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'timeout'
  );
}
