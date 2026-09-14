// AUP-CACHE-006 — test helper: the CACHE-004 replay fixture as gateway requests.
// Port of `tools/prompt-cache/replay_loop.py build_request()` (dry loop: the
// assistant answers with the fixture's acknowledgement). Used by the policy
// spec as the POSITIVE fixture matrix and by the latency measurement.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ReplayFixture {
  readonly schema: string;
  readonly base_request: Record<string, unknown>;
  readonly first_user_text: string;
  readonly tool_results: readonly string[];
  readonly dry_assistant_ack: string;
  readonly sentinel_in_l4: string;
}

export const REPLAY_FIXTURE_PATH = resolve(
  __dirname,
  '../fixtures/prompt-cache/replay-fixture.v1.json',
);

export function loadReplayFixture(): ReplayFixture {
  return JSON.parse(readFileSync(REPLAY_FIXTURE_PATH, 'utf8')) as ReplayFixture;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Request for step 1..N of the dry replay loop (byte-shape of the Python builder). */
export function buildReplayRequest(
  fixture: ReplayFixture,
  step: number,
  injectL1?: string,
): Record<string, unknown> {
  const request = clone(fixture.base_request);
  if (injectL1 !== undefined) {
    const system = request.system as { text: string }[];
    system[0].text += `\n${injectL1}`;
  }
  const messages: Record<string, unknown>[] = [
    { role: 'user', content: [{ type: 'text', text: fixture.first_user_text }] },
  ];
  for (let k = 1; k < step; k += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: fixture.dry_assistant_ack }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: fixture.tool_results[k - 1] }],
    });
  }
  const lastContent = messages[messages.length - 1].content as Record<string, unknown>[];
  lastContent[lastContent.length - 1].cache_control = { type: 'ephemeral' };
  request.messages = messages;
  return request;
}
