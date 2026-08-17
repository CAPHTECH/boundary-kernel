import { deepStrictEqual, match, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decide } from '../src/decide.ts';
import { RbkInvalidInputError, validateInputs } from '../src/validate.ts';
import type { Decision, FactorKind, Policy, Request } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS, passingEvidence } from './builders.ts';

/**
 * The kernel used to admit what it could not read.
 *
 * `decide()` performed no runtime validation, and the ordinal comparisons are
 * written with `Array.prototype.indexOf`, which answers `-1` for a value outside
 * its enum. `-1 > rank(ceiling)` is false, so the comparison raised no verdict
 * and no reason, and the factor resolved to `satisfied`. Eight fields composed
 * to `auto_apply` with `basis_complete: true` and an empty `reasons` array —
 * a decision that read as a clean pass. `"critical"` returned `human_required`;
 * `"CRITICAL"` returned `auto_apply`.
 *
 * These tests pin the direction rather than the wording: an input outside its
 * declared domain must never open the boundary, and must never do so silently.
 */

/** The eight fields that admitted an unreadable value, with a value each rejects. */
const FAIL_OPEN_SITES: {
  name: string;
  factor: FactorKind;
  path: string;
  apply: (policy: Policy, request: Request, value: unknown) => void;
  /** Values outside the declared domain: wrong case, wrong member, wrong type. */
  bad: unknown[];
}[] = [
  {
    name: 'action.risk.impact',
    factor: 'risk',
    path: 'request.action.risk.impact',
    apply: (_p, r, v) => ((r.action.risk as any).impact = v),
    bad: ['CRITICAL', 'severe', 9, null, undefined],
  },
  {
    name: 'action.applicability.status',
    factor: 'applicability',
    path: 'request.action.applicability.status',
    apply: (_p, r, v) => ((r.action.applicability as any) = { status: v }),
    bad: ['UNKNOWN', 'bogus', 9, null, undefined],
  },
  {
    name: 'evidence item freshness.status',
    factor: 'freshness',
    path: 'request.evidence_state.items[0].freshness.status',
    apply: (_p, r, v) => ((r.evidence_state.items[0] as any).freshness = { status: v }),
    bad: ['STALE', 'bogus', 1, null, undefined],
  },
  {
    name: 'action.risk.exposure',
    factor: 'risk',
    path: 'request.action.risk.exposure',
    apply: (_p, r, v) => ((r.action.risk as any).exposure = v),
    bad: ['abc', '0.1', null, true, Number.NaN],
  },
  {
    name: 'action.risk.uncertainty',
    factor: 'risk',
    path: 'request.action.risk.uncertainty',
    apply: (_p, r, v) => ((r.action.risk as any).uncertainty = v),
    bad: ['abc', '0.1', null, true, Number.NaN],
  },
  {
    name: 'evidence item outcome',
    factor: 'evidence',
    path: 'request.evidence_state.items[0].outcome',
    apply: (_p, r, v) => ((r.evidence_state.items[0] as any).outcome = v),
    bad: ['FAILED', 'bogus', 0, null, undefined],
  },
  {
    name: 'policy.reversibility.minimum',
    factor: 'reversibility',
    path: 'policy.reversibility.minimum',
    apply: (p, _r, v) => ((p.reversibility as any).minimum = v),
    // 'irreversible' is a real Severity-adjacent word but not a floor a policy
    // may set — the Rollback Fiction ban keeps it out of the domain.
    bad: ['REVERSIBLE', 'irreversible', 'bogus', null, undefined],
  },
  {
    name: 'policy.evidence.minimum_assurance',
    factor: 'evidence',
    path: 'policy.evidence.minimum_assurance',
    apply: (p, _r, v) => ((p.evidence as any).minimum_assurance = v),
    bad: ['FORMAL_VERIFIED', 'bogus', 3, null],
  },
];

function run(mutate: (policy: Policy, request: Request) => void): Decision {
  const policy = basePolicy();
  const request = baseRequest();
  mutate(policy, request);
  return decide(policy, request, DIGESTS, { computed_at: AT });
}

describe('fail-closed on input the kernel cannot read', () => {
  it('the base pair is auto_apply, so every rejection below is caused by the mutation', () => {
    strictEqual(run(() => {}).outcome, 'auto_apply');
  });

  for (const site of FAIL_OPEN_SITES) {
    for (const bad of site.bad) {
      const shown = typeof bad === 'string' ? `'${bad}'` : String(bad);

      it(`${site.name} = ${shown} does not reach auto_apply`, () => {
        const decision = run((p, r) => site.apply(p, r, bad));
        notStrictEqual(decision.outcome, 'auto_apply');
        strictEqual(decision.outcome, 'human_required');
      });

      it(`${site.name} = ${shown} records why, on the factor that reads it`, () => {
        const decision = run((p, r) => site.apply(p, r, bad));
        const factor = decision.factors.find((f) => f.factor === site.factor)!;
        strictEqual(factor.verdict, 'human_required');
        // Both axes: routing says a person decides, measurement says our basis
        // was short. The empty `reasons` array is what made this invisible.
        strictEqual(factor.basis_complete, false);
        strictEqual(decision.basis_complete, false);
        strictEqual(factor.reasons.length > 0, true);
        match(factor.reasons.join(' '), new RegExp(site.path.replace(/[.[\]]/g, '\\$&')));
      });

      it(`${site.name} = ${shown} withholds every requested dimension`, () => {
        const decision = run((p, r) => site.apply(p, r, bad));
        strictEqual(decision.granted_dimensions, undefined);
        deepStrictEqual(decision.withheld_dimensions, ['project', 'execute']);
      });
    }
  }
});

describe('the reason says what arrived and what was expected', () => {
  it('names the field, the offending value and the declared domain', () => {
    const decision = run((_p, r) => ((r.action.risk as any).impact = 'CRITICAL'));
    const risk = decision.factors.find((f) => f.factor === 'risk')!;
    const reason = risk.reasons.join(' ');
    match(reason, /request\.action\.risk\.impact/);
    match(reason, /'CRITICAL'/);
    match(reason, /none, low, medium, high, critical/);
  });

  it('distinguishes 9 from "9" so the host knows which defect arrived', () => {
    const asNumber = run((_p, r) => ((r.action.risk as any).impact = 9));
    const asString = run((_p, r) => ((r.action.risk as any).impact = '9'));
    match(asNumber.factors.find((f) => f.factor === 'risk')!.reasons.join(' '), /9 \(number\)/);
    match(asString.factors.find((f) => f.factor === 'risk')!.reasons.join(' '), /'9' \(string\)/);
  });

  it('reports an absent required field as absent rather than as a type', () => {
    const decision = run((_p, r) => delete (r.action.risk as any).impact);
    match(decision.factors.find((f) => f.factor === 'risk')!.reasons.join(' '), /is absent/);
  });
});

describe('a case difference is not a licence', () => {
  it('"critical" and "CRITICAL" both stay away from auto_apply', () => {
    const lower = run((p, r) => {
      p.risk.max_impact = 'medium';
      (r.action.risk as any).impact = 'critical';
    });
    const upper = run((p, r) => {
      p.risk.max_impact = 'medium';
      (r.action.risk as any).impact = 'CRITICAL';
    });
    strictEqual(lower.outcome, 'human_required');
    strictEqual(upper.outcome, 'human_required');

    // They are not the same decision, though: one exceeded a ceiling we could
    // read, the other could not be read at all. Only the second is a basis gap.
    strictEqual(lower.basis_complete, true);
    strictEqual(upper.basis_complete, false);
  });
});

describe('an unreadable field never routes to incomplete', () => {
  /**
   * `incomplete` means "observe more and come back". No amount of re-observation
   * repairs a malformed enum, and a host looping on `incomplete` would never
   * reach the person who could fix it. Malformed input routes to a human.
   */
  it('does not use the outcome whose remedy is further observation', () => {
    for (const site of FAIL_OPEN_SITES) {
      const decision = run((p, r) => site.apply(p, r, 'BOGUS'));
      notStrictEqual(decision.outcome, 'incomplete');
      strictEqual(decision.outcome, 'human_required');
    }
  });
});

describe('all six factors survive a defect', () => {
  it('a single unreadable field does not remove the other five', () => {
    const decision = run((_p, r) => ((r.action.risk as any).impact = 'BOGUS'));
    deepStrictEqual(
      decision.factors.map((f) => f.factor).sort(),
      ['applicability', 'authority', 'evidence', 'freshness', 'reversibility', 'risk'],
    );
  });

  it('factors whose inputs are readable still report their own verdict', () => {
    const decision = run((p, r) => {
      (r.action.risk as any).impact = 'BOGUS';
      p.authority.non_human_may_hold = ['observe'];
    });
    const authority = decision.factors.find((f) => f.factor === 'authority')!;
    strictEqual(authority.verdict, 'human_required');
    // Authority's own reason, not the risk defect's.
    match(authority.reasons.join(' '), /non_human_may_hold/);
  });
});

describe('an unreadable evidence item blocks both factors that read it', () => {
  /**
   * `evidence` and `freshness` judge exactly the items `qualifyingEvidence`
   * selected. If an item cannot be read, the selection is not sound, so neither
   * factor may lean on it.
   */
  it('blocks evidence and freshness together', () => {
    const decision = run((_p, r) => ((r.evidence_state.items[0] as any).assurance = 'BOGUS'));
    for (const kind of ['evidence', 'freshness'] as const) {
      const factor = decision.factors.find((f) => f.factor === kind)!;
      strictEqual(factor.verdict, 'human_required', `${kind} should be blocked`);
      strictEqual(factor.reasons.length > 0, true);
    }
  });
});

describe('shape that cannot be digested throws instead of returning a decision', () => {
  /**
   * `identity.policy_digest` is mandatory in rbk.decision.v3. If the policy
   * cannot be normalized there is no digest, and a decision without one is not
   * a decision this kernel may emit — so there is nothing honest to return.
   */
  it('throws when evidence_state.items is not an array', () => {
    throws(
      () => run((_p, r) => ((r.evidence_state as any).items = 'nope')),
      (error: unknown) => {
        strictEqual(error instanceof RbkInvalidInputError, true);
        match((error as Error).message, /request\.evidence_state\.items/);
        return true;
      },
    );
  });

  it('throws when the policy is not an object at all', () => {
    throws(
      () => decide(null as any, baseRequest(), DIGESTS, { computed_at: AT }),
      RbkInvalidInputError,
    );
  });

  it('collects every shape defect rather than stopping at the first', () => {
    try {
      decide(
        basePolicy(),
        baseRequest({ action: { requested_dimensions: 'no' as any, risk: null as any } }),
        DIGESTS,
        { computed_at: AT },
      );
      throw new Error('expected RbkInvalidInputError');
    } catch (error) {
      strictEqual(error instanceof RbkInvalidInputError, true);
      strictEqual((error as RbkInvalidInputError).defects.length >= 2, true);
    }
  });
});

describe('validateInputs is usable ahead of decide()', () => {
  it('returns nothing for a pair the kernel can evaluate', () => {
    deepStrictEqual(validateInputs(basePolicy(), baseRequest()), []);
  });

  it('attributes each defect to the factor that reads the field', () => {
    const policy = basePolicy();
    const request = baseRequest();
    (request.action.risk as any).impact = 'BOGUS';
    (request.action as any).reversibility = 'BOGUS';
    const defects = validateInputs(policy, request);
    deepStrictEqual(
      [...new Set(defects.map((d) => d.factor))].sort(),
      ['reversibility', 'risk'],
    );
  });
});

describe('valid input is unchanged by validation', () => {
  it('every declared enum member is still accepted', () => {
    for (const impact of ['none', 'low', 'medium'] as const) {
      strictEqual(run((_p, r) => ((r.action.risk as any).impact = impact)).outcome, 'auto_apply');
    }
  });

  it('optional fields may still be absent', () => {
    const decision = run((p, r) => {
      delete (p.risk as any).max_exposure;
      delete (p.risk as any).max_uncertainty;
      delete (p.evidence as any).minimum_assurance;
      delete (r.action as any).domain;
      delete (r.action as any).applicability;
      delete (r.action.risk as any).exposure;
      delete (r.action.risk as any).uncertainty;
    });
    strictEqual(decision.outcome, 'auto_apply');
  });

  it('an evidence item without optional freshness detail is still readable', () => {
    const decision = run((_p, r) => {
      r.evidence_state = { items: [passingEvidence({ freshness: { status: 'fresh' } })] };
    });
    strictEqual(decision.outcome, 'auto_apply');
  });
});
