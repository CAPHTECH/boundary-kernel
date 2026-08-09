/**
 * Boundary conditions: the thresholds exactly, absent values, and empty
 * collections.
 *
 * The independent review found these untested, and they are where a boundary
 * kernel actually fails — an off-by-one on a ceiling silently widens what may
 * be applied without a human, and "absent" quietly read as "fine" is the
 * `unknown`-treated-as-`reversible` mistake in a different costume.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decide } from '../src/decide.ts';
import type { Decision, FactorKind, Policy, Request } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS, passingEvidence } from './builders.ts';

const run = (policy: Policy, request: Request): Decision =>
  decide(policy, request, DIGESTS, { computed_at: AT });

const verdictOf = (decision: Decision, factor: FactorKind) =>
  decision.factors.find((f) => f.factor === factor)!;

describe('thresholds are inclusive ceilings, not exclusive ones', () => {
  it('impact exactly at max_impact is satisfied; one step above is not', () => {
    // basePolicy: max_impact = 'medium'
    const at = run(basePolicy(), baseRequest({ action: { risk: { impact: 'medium', exposure: 0.1, uncertainty: 0.05 } } }));
    strictEqual(verdictOf(at, 'risk').verdict, 'satisfied');
    strictEqual(at.outcome, 'auto_apply');

    const above = run(basePolicy(), baseRequest({ action: { risk: { impact: 'high', exposure: 0.1, uncertainty: 0.05 } } }));
    strictEqual(verdictOf(above, 'risk').verdict, 'human_required');
  });

  it('exposure exactly at max_exposure is satisfied', () => {
    // basePolicy: max_exposure = 0.5
    const at = run(basePolicy(), baseRequest({ action: { risk: { impact: 'low', exposure: 0.5, uncertainty: 0.05 } } }));
    strictEqual(verdictOf(at, 'risk').verdict, 'satisfied');

    const above = run(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'low', exposure: 0.500001, uncertainty: 0.05 } } }),
    );
    strictEqual(verdictOf(above, 'risk').verdict, 'human_required');
  });

  it('uncertainty exactly at max_uncertainty is satisfied; above it is incomplete, not human_required', () => {
    // basePolicy: max_uncertainty = 0.3
    const at = run(basePolicy(), baseRequest({ action: { risk: { impact: 'low', exposure: 0.1, uncertainty: 0.3 } } }));
    strictEqual(verdictOf(at, 'risk').verdict, 'satisfied');
    strictEqual(at.basis_complete, true);

    const above = run(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'low', exposure: 0.1, uncertainty: 0.300001 } } }),
    );
    strictEqual(verdictOf(above, 'risk').verdict, 'incomplete');
    strictEqual(above.basis_complete, false);
  });

  it('evidence exactly max_age_seconds old is still fresh; a second older is not', () => {
    // basePolicy: max_age_seconds = 3600
    const aged = (observed_at: string, now: string) =>
      run(
        basePolicy(),
        baseRequest({
          evidence_state: { items: [passingEvidence({ freshness: { status: 'fresh', observed_at } })] },
          observed_at: now,
        }),
      );

    const at = aged('2026-08-09T08:00:00Z', '2026-08-09T09:00:00Z'); // exactly 3600s
    strictEqual(verdictOf(at, 'freshness').verdict, 'satisfied');

    const above = aged('2026-08-09T07:59:59Z', '2026-08-09T09:00:00Z'); // 3601s
    strictEqual(verdictOf(above, 'freshness').verdict, 'incomplete');
  });

  it('assurance exactly at minimum_assurance qualifies', () => {
    const policy = basePolicy({
      evidence: {
        required: true,
        accepted_modes: ['executable_test'],
        minimum_count: 1,
        minimum_assurance: 'statistically_supported',
      },
    });
    const at = run(
      policy,
      baseRequest({ evidence_state: { items: [passingEvidence({ assurance: 'statistically_supported' })] } }),
    );
    strictEqual(verdictOf(at, 'evidence').verdict, 'satisfied');

    const below = run(
      policy,
      baseRequest({ evidence_state: { items: [passingEvidence({ assurance: 'evaluator_supported' })] } }),
    );
    strictEqual(verdictOf(below, 'evidence').verdict, 'incomplete');
  });

  it('exactly minimum_count qualifying items is enough', () => {
    const policy = basePolicy({
      evidence: { required: true, accepted_modes: ['executable_test'], minimum_count: 2 },
    });
    const two = run(
      policy,
      baseRequest({
        evidence_state: { items: [passingEvidence(), passingEvidence({ evidence_id: 'ev-2' })] },
      }),
    );
    strictEqual(verdictOf(two, 'evidence').verdict, 'satisfied');
  });

  it('minimum_count = 0 is satisfied by no evidence at all', () => {
    // A policy may legitimately require evidence handling without requiring a
    // count; 0 must mean 0, not fall back to the default of 1.
    const policy = basePolicy({
      evidence: { required: true, accepted_modes: ['executable_test'], minimum_count: 0 },
    });
    const decision = run(policy, baseRequest({ evidence_state: { items: [] } }));
    strictEqual(verdictOf(decision, 'evidence').verdict, 'satisfied');
  });

  it('an omitted minimum_count means 1, not 0', () => {
    const policy = basePolicy({ evidence: { required: true, accepted_modes: ['executable_test'] } });
    strictEqual(
      verdictOf(run(policy, baseRequest({ evidence_state: { items: [] } })), 'evidence').verdict,
      'incomplete',
    );
    strictEqual(verdictOf(run(policy, baseRequest()), 'evidence').verdict, 'satisfied');
  });
});

describe('absent values are never read as satisfied', () => {
  it('a missing exposure against a declared ceiling is incomplete', () => {
    const decision = run(basePolicy(), baseRequest({ action: { risk: { impact: 'low', uncertainty: 0.05 } } }));
    const risk = verdictOf(decision, 'risk');
    strictEqual(risk.verdict, 'incomplete');
    strictEqual(risk.basis_complete, false);
  });

  it('a missing exposure against no ceiling is not a gap at all', () => {
    const policy = basePolicy({ risk: { max_impact: 'medium' } });
    const decision = run(policy, baseRequest({ action: { risk: { impact: 'low' } } }));
    strictEqual(verdictOf(decision, 'risk').verdict, 'satisfied');
    strictEqual(decision.basis_complete, true);
  });

  it('a missing observed_at leaves max_age unchecked rather than assumed stale', () => {
    // The host asserted freshness; max_age_seconds is a secondary cross-check,
    // and an absent timestamp means it simply cannot run.
    const decision = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ freshness: { status: 'fresh' } })] } }),
    );
    strictEqual(verdictOf(decision, 'freshness').verdict, 'satisfied');
  });

  it('a missing request.observed_at has the same effect', () => {
    const request = baseRequest();
    delete request.observed_at;
    strictEqual(verdictOf(run(basePolicy(), request), 'freshness').verdict, 'satisfied');
  });

  it('an unparseable timestamp does not silently become age 0', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'fresh', observed_at: 'not-a-date' } })],
        },
      }),
    );
    // No age can be computed, so the age check does not run; the host's
    // freshness assertion stands and nothing is invented from a bad value.
    strictEqual(verdictOf(decision, 'freshness').verdict, 'satisfied');
  });

  it('an omitted applicability block adds no constraint', () => {
    const request = baseRequest();
    delete request.action.applicability;
    strictEqual(verdictOf(run(basePolicy(), request), 'applicability').verdict, 'satisfied');
  });

  it('an omitted action.domain is not out of scope', () => {
    const request = baseRequest();
    delete request.action.domain;
    strictEqual(verdictOf(run(basePolicy(), request), 'applicability').verdict, 'satisfied');
  });

  it('an omitted policy.scope.domains does not narrow anything', () => {
    const policy = basePolicy({ scope: { action_kinds: ['code.patch'] } });
    strictEqual(
      verdictOf(run(policy, baseRequest({ action: { domain: 'anything-at-all' } })), 'applicability').verdict,
      'satisfied',
    );
  });
});

describe('empty collections mean empty, not absent', () => {
  it('no evidence is incomplete — never confused with "evidence not required"', () => {
    const decision = run(basePolicy(), baseRequest({ evidence_state: { items: [] } }));
    strictEqual(verdictOf(decision, 'evidence').verdict, 'incomplete');
    deepStrictEqual(verdictOf(decision, 'evidence').evidence_ids, []);
    strictEqual(decision.outcome, 'incomplete');
    strictEqual(decision.basis_complete, false);
  });

  it('freshness has nothing to judge when no item qualifies', () => {
    const decision = run(basePolicy(), baseRequest({ evidence_state: { items: [] } }));
    const freshness = verdictOf(decision, 'freshness');
    strictEqual(freshness.verdict, 'satisfied');
    deepStrictEqual(freshness.evidence_ids, []);
    // The gap is reported by `evidence`, once — not smeared across factors.
    strictEqual(freshness.basis_complete, true);
  });

  it('an empty human_reserved reserves nothing', () => {
    const policy = basePolicy({
      authority: { non_human_may_hold: ['project', 'execute'], human_reserved: [] },
    });
    strictEqual(verdictOf(run(policy, baseRequest()), 'authority').verdict, 'satisfied');
  });

  it('an empty tolerated_staleness_reasons tolerates nothing', () => {
    const policy = basePolicy({
      freshness: { require_fresh: true, max_age_seconds: 3600, tolerated_staleness_reasons: [] },
    });
    const decision = run(
      policy,
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'stale', reasons: ['extractor_changed'] } })],
        },
      }),
    );
    strictEqual(verdictOf(decision, 'freshness').verdict, 'incomplete');
  });

  it('an empty stale reasons array is treated as "reason unknown", like an omitted one', () => {
    const withEmpty = run(
      basePolicy(),
      baseRequest({
        evidence_state: { items: [passingEvidence({ freshness: { status: 'stale', reasons: [] } })] },
      }),
    );
    const withNone = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ freshness: { status: 'stale' } })] } }),
    );
    strictEqual(verdictOf(withEmpty, 'freshness').verdict, 'incomplete');
    deepStrictEqual(
      verdictOf(withEmpty, 'freshness').reasons,
      verdictOf(withNone, 'freshness').reasons,
    );
  });

  it('an empty requested_dimensions grants an empty set — never everything', () => {
    // Schema-invalid input (minItems 1), pinned so that a future relaxation
    // cannot quietly turn "nothing requested" into a blanket grant.
    const decision = run(basePolicy(), baseRequest({ action: { requested_dimensions: [] } }));
    strictEqual(decision.outcome, 'auto_apply');
    deepStrictEqual(decision.granted_dimensions, []);
    deepStrictEqual(decision.withheld_dimensions, []);
  });
});
