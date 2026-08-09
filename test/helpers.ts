import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Decision, Policy, Request } from '../src/types.ts';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface Fixture {
  name: string;
  policy: Policy;
  request: Request;
  expected: Decision;
}

export const FIXTURE_NAMES = [
  '01-auto-apply',
  '02-authority-withheld',
  '03-incomplete-stale-evidence',
  '04-human-required-risk',
] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadFixture(name: string): Fixture {
  const dir = join(ROOT, 'fixtures', name);
  return {
    name,
    policy: readJson<Policy>(join(dir, 'policy.json')),
    request: readJson<Request>(join(dir, 'request.json')),
    expected: readJson<Decision>(join(dir, 'expected-decision.json')),
  };
}

/**
 * Fields that cannot be reproduced by a deterministic computation and are
 * therefore excluded from fixture comparison:
 *
 *   computed_at          — wall clock
 *   decision_id          — the fixtures carry placeholder hashes (README:
 *                          "digest 類はダミー値"), not hashes of their own inputs
 *   routing.escalate_to  — no policy field supplies an escalation target
 *
 * Everything else is compared exactly.
 */
export function comparable(decision: Decision): Omit<Decision, 'decision_id' | 'computed_at'> {
  const { decision_id: _id, computed_at: _at, routing, ...rest } = decision;
  const trimmedRouting = routing ? { ...routing } : undefined;
  if (trimmedRouting) delete trimmedRouting.escalate_to;
  return trimmedRouting === undefined ? rest : { ...rest, routing: trimmedRouting };
}
