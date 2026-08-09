import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compose, decide } from '../src/decide.ts';
import type { Verdict } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS, passingEvidence } from './builders.ts';

const VERDICTS: Verdict[] = ['satisfied', 'human_required', 'incomplete'];

describe('composition rule', () => {
  it('is exhaustive over all 3^6 factor verdict combinations', () => {
    let checked = 0;
    const walk = (acc: Verdict[]): void => {
      if (acc.length === 6) {
        checked += 1;
        const expected = acc.includes('human_required')
          ? 'human_required'
          : acc.includes('incomplete')
            ? 'incomplete'
            : 'auto_apply';
        strictEqual(compose(acc), expected, `combination ${acc.join('+')}`);
        return;
      }
      for (const verdict of VERDICTS) walk([...acc, verdict]);
    };
    walk([]);
    strictEqual(checked, 3 ** 6);
  });

  it('human_required wins whenever it co-occurs with incomplete', () => {
    // The asymmetry at the heart of the design: a settled restriction beats an
    // unresolved unknown.
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        if (i === j) continue;
        const verdicts: Verdict[] = new Array(6).fill('satisfied');
        verdicts[i] = 'human_required';
        verdicts[j] = 'incomplete';
        strictEqual(compose(verdicts), 'human_required');
      }
    }
  });

  it('incomplete only appears when nothing is human_required', () => {
    strictEqual(compose(['satisfied', 'incomplete', 'satisfied', 'satisfied', 'satisfied', 'satisfied']), 'incomplete');
    strictEqual(compose(['satisfied', 'satisfied', 'satisfied', 'satisfied', 'satisfied', 'satisfied']), 'auto_apply');
  });

  it('never collapses incomplete into human_required', () => {
    strictEqual(compose(['incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete']), 'incomplete');
  });
});

describe('composition rule through decide()', () => {
  const run = (policy = basePolicy(), request = baseRequest()) =>
    decide(policy, request, DIGESTS, { computed_at: AT });

  it('all satisfied → auto_apply, with granted dimensions and nothing withheld', () => {
    const decision = run();
    strictEqual(decision.outcome, 'auto_apply');
    deepStrictEqual(decision.granted_dimensions, ['project', 'execute']);
    deepStrictEqual(decision.withheld_dimensions, []);
    deepStrictEqual(decision.routing, {});
  });

  it('a lone incomplete factor → incomplete', () => {
    // reversibility unknown is incomplete, never "reversible"
    const decision = run(basePolicy(), baseRequest({ action: { reversibility: 'unknown' } }));
    strictEqual(decision.outcome, 'incomplete');
    strictEqual(decision.factors.find((f) => f.factor === 'reversibility')?.verdict, 'incomplete');
  });

  it('human_required and incomplete together → human_required', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        action: {
          // risk.impact over the ceiling → human_required
          risk: { impact: 'critical', exposure: 0.1, uncertainty: 0.05 },
          // reversibility unknown → incomplete
          reversibility: 'unknown',
        },
      }),
    );
    const verdicts = Object.fromEntries(decision.factors.map((f) => [f.factor, f.verdict]));
    strictEqual(verdicts['risk'], 'human_required');
    strictEqual(verdicts['reversibility'], 'incomplete');
    strictEqual(decision.outcome, 'human_required');
  });

  it('a decision that is not auto_apply withholds every requested dimension', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ freshness: { status: 'unknown' } })] } }),
    );
    strictEqual(decision.outcome, 'incomplete');
    strictEqual(decision.granted_dimensions, undefined);
    deepStrictEqual(decision.withheld_dimensions, ['project', 'execute']);
  });

  it('always returns all six factors, satisfied ones included', () => {
    const decision = run();
    strictEqual(decision.factors.length, 6);
    strictEqual(
      decision.factors.every((f) => f.verdict === 'satisfied'),
      true,
    );
  });

  it('every non-satisfied factor carries at least one reason', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        action: {
          reversibility: 'irreversible',
          requested_dimensions: ['authorize'],
          risk: { impact: 'critical', exposure: 0.9, uncertainty: 0.9 },
          applicability: { status: 'unknown' },
        },
        evidence_state: { items: [] },
      }),
    );
    for (const factor of decision.factors) {
      if (factor.verdict !== 'satisfied') {
        strictEqual(factor.reasons.length > 0, true, `${factor.factor} reported without reasons`);
      }
    }
  });
});
