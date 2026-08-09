import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compose, composeBasis, decide } from '../src/decide.ts';
import type { Decision, Verdict } from '../src/types.ts';
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

describe('measurement axis (basis_complete)', () => {
  it('is the conjunction over the factors', () => {
    strictEqual(composeBasis([{ basis_complete: true }, { basis_complete: true }]), true);
    strictEqual(composeBasis([{ basis_complete: true }, { basis_complete: false }]), false);
    strictEqual(composeBasis([]), true);
  });

  it('is independent of the routing axis — the whole point of the v0.2 split', () => {
    // A factor may route to human_required and still report a missing basis.
    strictEqual(
      composeBasis([{ basis_complete: false }]),
      false,
      'a human_required routing must not repair a missing basis',
    );
  });
});

describe('the two-axis invariant', () => {
  /**
   * outcome === 'incomplete'
   *   <=> basis_complete === false and no factor is human_required.
   *
   * v0.1 violated the right-to-left direction by construction: a
   * human_required factor discarded any co-occurring incomplete, so the fact
   * that the basis was short became unrepresentable.
   */
  const holds = (decision: Decision): boolean => {
    const anyHumanRequired = decision.factors.some((f) => f.verdict === 'human_required');
    return (decision.outcome === 'incomplete') === (!decision.basis_complete && !anyHumanRequired);
  };

  it('holds for every combination of factor signals decide() can produce', () => {
    // Each entry drives one factor to a specific (verdict, basis) pair.
    const actions = [
      {}, // all satisfied
      { applicability: { status: 'unknown' as const } }, // incomplete
      { applicability: { status: 'not_applicable' as const, reasons: ['n/a'] } }, // human_required
      { reversibility: 'unknown' as const }, // incomplete
      { reversibility: 'irreversible' as const }, // human_required
      { risk: { impact: 'low' as const, exposure: 0.1, uncertainty: 0.9 } }, // incomplete
      { risk: { impact: 'critical' as const, exposure: 0.1, uncertainty: 0.05 } }, // human_required
      // One factor raising both signals at once: human_required routing,
      // missing basis.
      { risk: { impact: 'critical' as const, exposure: 0.1, uncertainty: 0.9 } },
      { requested_dimensions: ['authorize' as const] }, // authority: human_required
    ];
    const evidenceStates = [
      undefined,
      { items: [] }, // evidence: incomplete
      { items: [passingEvidence({ evidence_id: 'ev-fail', outcome: 'failed' as const })] },
      { items: [passingEvidence({ freshness: { status: 'unknown' as const } })] },
    ];

    let checked = 0;
    for (const action of actions) {
      for (const evidence_state of evidenceStates) {
        const decision = decide(
          basePolicy(),
          baseRequest({ action, ...(evidence_state ? { evidence_state } : {}) }),
          DIGESTS,
          { computed_at: AT },
        );
        strictEqual(holds(decision), true, `invariant broken for ${JSON.stringify({ action, evidence_state })}`);
        checked += 1;
      }
    }
    strictEqual(checked, actions.length * evidenceStates.length);
  });

  it('human_required and a missing basis co-exist — v0.1 could not say this', () => {
    const decision = decide(
      basePolicy(),
      baseRequest({
        action: {
          risk: { impact: 'critical', exposure: 0.1, uncertainty: 0.05 }, // human_required
          reversibility: 'unknown', // incomplete
        },
      }),
      DIGESTS,
      { computed_at: AT },
    );
    strictEqual(decision.outcome, 'human_required');
    strictEqual(decision.basis_complete, false);
    strictEqual(holds(decision), true);
    // and the gap is actionable, not merely recorded
    strictEqual((decision.routing?.required_evidence_modes ?? []).length > 0, true);
  });

  it('a single factor carrying both signals keeps them apart', () => {
    const decision = decide(
      basePolicy(),
      // risk alone: impact over the ceiling (settled) AND uncertainty over the
      // ceiling (missing basis).
      baseRequest({ action: { risk: { impact: 'critical', exposure: 0.1, uncertainty: 0.9 } } }),
      DIGESTS,
      { computed_at: AT },
    );
    const risk = decision.factors.find((f) => f.factor === 'risk')!;
    strictEqual(risk.verdict, 'human_required');
    strictEqual(risk.basis_complete, false, 'the incomplete signal must survive its own factor');
    strictEqual(decision.outcome, 'human_required');
    strictEqual(decision.basis_complete, false);
  });

  it('auto_apply always has a complete basis', () => {
    const decision = decide(basePolicy(), baseRequest(), DIGESTS, { computed_at: AT });
    strictEqual(decision.outcome, 'auto_apply');
    strictEqual(decision.basis_complete, true);
  });

  it('a settled human_required with nothing missing keeps basis_complete true', () => {
    const decision = decide(
      basePolicy(),
      baseRequest({ action: { requested_dimensions: ['authorize'] } }),
      DIGESTS,
      { computed_at: AT },
    );
    strictEqual(decision.outcome, 'human_required');
    strictEqual(decision.basis_complete, true);
    deepStrictEqual(decision.routing, {});
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
