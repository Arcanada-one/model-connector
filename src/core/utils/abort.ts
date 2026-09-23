/**
 * A2-210 — one predicate for "this request ran out of time", because the two
 * ways to run out of time do not throw the same `name`.
 *
 *   AbortSignal.timeout(ms)      aborts with DOMException name 'TimeoutError'
 *   AbortController#abort()      aborts with DOMException name 'AbortError'
 *
 * Every outbound deadline in this service is `AbortSignal.timeout()`, so the
 * name that actually arrives is `TimeoutError` — measured on Node v24.20.0:
 *
 *   fetch(hangingServer, { signal: AbortSignal.timeout(150) })
 *     -> DOMException { name: 'TimeoutError',
 *                       message: 'The operation was aborted due to timeout' }
 *
 * Four call sites each spelled the check out by hand and four of them asked for
 * `AbortError` alone, so the branch was unreachable and every provider timeout
 * surfaced as `network_error`. The check lives here once so the next site
 * cannot get it wrong, and so a test can assert the predicate itself rather
 * than a hand-built DOMException that Node would never produce.
 *
 * `AbortError` is kept because a caller-supplied `AbortController` is a
 * deadline too from the connector's point of view; the distinction that
 * matters downstream (whose budget expired) is drawn from the budget figures,
 * not from the exception name.
 */
export function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
