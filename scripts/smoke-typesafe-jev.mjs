#!/usr/bin/env node
/**
 * CONN-JEV-04 — live smoke for POST /connectors/typesafe-jev/execute.
 *
 * Fail-closed: missing MC_KEY exits unauthorized (NOT_MEASURED), never invents PASS.
 * Never prints secret material. Response judge covers:
 *   - HTTP 201 + body.status=success + structured.status=observed
 *   - usage.costUsd present (ledger Request mirror via A2-223 costSource)
 *   - paid costSource + costUsd===0 → FAIL (A2-223 class defect)
 *
 * Exit codes:
 *   0  PASS
 *   1  FAIL (HTTP/body/cost negative control)
 *   2  usage (bad args / curl missing)
 *   10 unauthorized / runtime not authorized (MC_KEY absent) → NOT_MEASURED
 *   11 probe error (network / non-JSON) → NOT_MEASURED for live criteria
 */

import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAID_COST_SOURCES = new Set(['provider', 'catalog']);
const DEFAULT_BASE = 'https://connector.arcanada.ai';

/** Minimal DecisionRequest/v1 for shadow smoke (no secrets in state). */
export function buildDecisionPrompt(state = 'CONN-JEV-04 live smoke synthetic task') {
  return JSON.stringify({
    version: 'DecisionRequest/v1',
    mode: 'shadow',
    decisionType: 'task-routing',
    policyId: 'conn-jev-04-smoke-v1',
    model: 'jev-latest',
    state,
    questions: {
      tier: {
        type: 'choice',
        instructions: 'Choose a capability band',
        criteria: { small: 'Simple task', large: 'Complex task' },
      },
      complexity: {
        type: 'score',
        instructions: 'Rate complexity',
        criteria: ['Low', 'Medium', 'High'],
      },
      risk: { type: 'noul', instructions: 'Is the task risky?' },
    },
  });
}

/**
 * @param {{ httpStatus: number, body: any }} observation
 * @returns {{ verdict: 'PASS'|'FAIL', reasons: string[], observations: Record<string, unknown> }}
 */
export function judge(observation) {
  const reasons = [];
  const body = observation?.body;
  const httpStatus = observation?.httpStatus;
  const usage = body?.usage ?? null;
  const structured = body?.structured ?? null;
  const costUsd = usage?.costUsd;
  const costSource = usage?.costSource ?? null;

  if (httpStatus !== 201) {
    reasons.push(`expected HTTP 201, got ${httpStatus}`);
  }
  if (body?.status !== 'success') {
    reasons.push(`expected body.status=success, got ${JSON.stringify(body?.status)}`);
  }
  if (structured?.status !== 'observed') {
    reasons.push(
      `expected structured.status=observed, got ${JSON.stringify(structured?.status)}`,
    );
  }
  if (usage == null || typeof usage !== 'object') {
    reasons.push('usage object missing (ledger Request mirror not observable)');
  } else if (!Object.prototype.hasOwnProperty.call(usage, 'costUsd')) {
    reasons.push('usage.costUsd missing (Request.costUsd not mirrored)');
  } else if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) {
    reasons.push(`usage.costUsd must be a finite number, got ${JSON.stringify(costUsd)}`);
  }

  // A2-223 negative control: a paid call must not settle as silent $0.
  if (PAID_COST_SOURCES.has(costSource) && costUsd === 0) {
    reasons.push(
      `A2-223: costSource=${costSource} with costUsd=0 (paid call settled as free)`,
    );
  }

  // Unpriced success is measurable but fails the "paid non-zero" product gate.
  if (body?.status === 'success' && costSource === 'unpriced' && costUsd === 0) {
    reasons.push(
      'A2-223-class: costSource=unpriced with costUsd=0 (served without a known price)',
    );
  }

  return {
    verdict: reasons.length === 0 ? 'PASS' : 'FAIL',
    reasons,
    observations: {
      httpStatus,
      bodyStatus: body?.status ?? null,
      structuredStatus: structured?.status ?? null,
      requestId: body?.id ?? null,
      connector: body?.connector ?? null,
      model: body?.model ?? null,
      costUsd: typeof costUsd === 'number' ? costUsd : null,
      costSource,
      usageMissing: usage?.usageMissing === true,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      errorCode: body?.error?.details?.code ?? body?.error?.type ?? null,
    },
  };
}

export function parseArgs(argv) {
  const out = {
    baseUrl: process.env.MC_BASE_URL || DEFAULT_BASE,
    receiptPath: null,
    state: 'CONN-JEV-04 live smoke synthetic task',
    dryJudge: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') out.baseUrl = String(argv[++i] || '');
    else if (a === '--receipt') out.receiptPath = String(argv[++i] || '');
    else if (a === '--state') out.state = String(argv[++i] || '');
    else if (a === '--dry-judge') out.dryJudge = String(argv[++i] || '');
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.baseUrl) throw new Error('--base-url must be non-empty');
  return out;
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  // Keep only bounded non-secret fields for receipts.
  return {
    id: body.id,
    connector: body.connector,
    model: body.model,
    status: body.status,
    latencyMs: body.latencyMs,
    usage: body.usage
      ? {
          inputTokens: body.usage.inputTokens,
          outputTokens: body.usage.outputTokens,
          totalTokens: body.usage.totalTokens,
          costUsd: body.usage.costUsd,
          costSource: body.usage.costSource,
          usageMissing: body.usage.usageMissing,
        }
      : null,
    structured: body.structured
      ? {
          status: body.structured.status,
          mode: body.structured.mode,
          action: body.structured.action,
          requestedModel: body.structured.requestedModel,
          observedModel: body.structured.observedModel,
          policyId: body.structured.policyId,
        }
      : null,
    error: body.error
      ? {
          type: body.error.type,
          message: body.error.message,
          code: body.error.details?.code,
        }
      : null,
  };
}

async function probeHealth(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/health/connectors`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const jev = (json?.connectors || []).find((c) => c?.name === 'typesafe-jev') || null;
  return {
    httpStatus: res.status,
    buildSha: null, // filled by /health when needed
    typesafeJev: jev,
  };
}

async function probeBuild(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { redirect: 'follow' });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, build: json?.build ?? null };
}

async function executeSmoke({ baseUrl, apiKey, prompt }) {
  const url = `${baseUrl.replace(/\/$/, '')}/connectors/typesafe-jev/execute`;
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `conn-jev-04-${randomUUID()}`,
    },
    body: JSON.stringify({
      prompt,
      model: 'jev-latest',
      maxRetries: 0,
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { parse_error: true, text_sha256: createHash('sha256').update(text).digest('hex') };
  }
  return { httpStatus: res.status, body };
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export async function runSmoke(opts) {
  const capturedAt = new Date().toISOString();
  const apiKey = process.env.MC_KEY || process.env.MC_API_KEY || '';
  const receiptBase = {
    schema: 'ConnJev04LiveSmoke/v1',
    task: 'b8896c8e-7e40-4608-a547-263d8bb11fc0',
    card: 'CONN-JEV-04',
    captured_at_utc: capturedAt,
    base_url: opts.baseUrl,
    runtime_authorized: Boolean(apiKey.trim()),
    knowledge_admitted: false,
  };

  if (opts.dryJudge) {
    const observation = JSON.parse(opts.dryJudge);
    const judged = judge(observation);
    return { exitCode: judged.verdict === 'PASS' ? 0 : 1, receipt: { ...receiptBase, ...judged } };
  }

  const build = await probeBuild(opts.baseUrl).catch((err) => ({
    httpStatus: 0,
    build: null,
    error: String(err?.message || err),
  }));
  const health = await probeHealth(opts.baseUrl).catch((err) => ({
    httpStatus: 0,
    typesafeJev: null,
    error: String(err?.message || err),
  }));

  if (!apiKey.trim()) {
    const receipt = {
      ...receiptBase,
      runtime_authorized: false,
      verdict: 'NOT_MEASURED',
      reasons: ['MC_KEY/MC_API_KEY absent — fail-closed; live execute not attempted'],
      preflight: {
        build,
        typesafe_jev_health: health.typesafeJev,
        health_http: health.httpStatus,
      },
    };
    return { exitCode: 10, receipt };
  }

  const prompt = buildDecisionPrompt(opts.state);
  let observation;
  try {
    observation = await executeSmoke({ baseUrl: opts.baseUrl, apiKey, prompt });
  } catch (err) {
    const receipt = {
      ...receiptBase,
      verdict: 'NOT_MEASURED',
      reasons: [`execute probe error: ${String(err?.message || err)}`],
      preflight: { build, typesafe_jev_health: health.typesafeJev },
    };
    return { exitCode: 11, receipt };
  }

  const judged = judge(observation);
  const receipt = {
    ...receiptBase,
    verdict: judged.verdict,
    reasons: judged.reasons,
    observations: {
      ...judged.observations,
      body_redacted: redactBody(observation.body),
    },
    preflight: {
      build,
      typesafe_jev_health: health.typesafeJev,
      health_http: health.httpStatus,
    },
  };
  return { exitCode: judged.verdict === 'PASS' ? 0 : 1, receipt };
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`ERR: ${err.message}`);
    return 2;
  }
  if (opts.help) {
    console.log(
      'Usage: smoke-typesafe-jev.mjs [--base-url URL] [--receipt PATH] [--state TEXT]\n' +
        'Requires MC_KEY (or MC_API_KEY). Missing key → exit 10 (NOT_MEASURED).',
    );
    return 0;
  }

  const { exitCode, receipt } = await runSmoke(opts);
  const defaultReceipt = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'receipts',
    'mc',
    `conn-jev-04-live-${capturedStamp()}.json`,
  );
  const path = opts.receiptPath || defaultReceipt;
  writeReceipt(path, receipt);
  // Never print secrets; summarize only.
  const buildInfo = receipt.preflight?.build?.build ?? null;
  console.log(
    JSON.stringify(
      {
        verdict: receipt.verdict,
        exitCode,
        runtime_authorized: receipt.runtime_authorized,
        reasons: receipt.reasons,
        receipt: path,
        build: buildInfo,
        typesafe_jev_health: receipt.preflight?.typesafe_jev_health ?? null,
        observations: receipt.observations
          ? {
              httpStatus: receipt.observations.httpStatus,
              bodyStatus: receipt.observations.bodyStatus,
              costUsd: receipt.observations.costUsd,
              costSource: receipt.observations.costSource,
              errorCode: receipt.observations.errorCode,
            }
          : null,
      },
      null,
      2,
    ),
  );
  return exitCode;
}

function capturedStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
