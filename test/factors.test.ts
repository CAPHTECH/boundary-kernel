import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decide } from '../src/decide.ts';
import type { Decision, FactorKind, Policy, Request } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS, passingEvidence } from './builders.ts';

const run = (policy: Policy, request: Request): Decision =>
  decide(policy, request, DIGESTS, { computed_at: AT });

const verdictOf = (decision: Decision, factor: FactorKind) =>
  decision.factors.find((f) => f.factor === factor)!;

describe('applicability', () => {
  it('an action_kind outside policy.scope is not_applicable → human_required', () => {
    const decision = run(basePolicy(), baseRequest({ action: { action_kind: 'rag.config_change' } }));
    const factor = verdictOf(decision, 'applicability');
    strictEqual(factor.verdict, 'human_required');
    match(factor.reasons[0]!, /not in policy\.scope\.action_kinds/);
  });

  it('capability_missing is incomplete, not not_applicable', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ action: { applicability: { status: 'capability_missing' } } }),
    );
    const factor = verdictOf(decision, 'applicability');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons.join(' '), /not the same as not_applicable/);
  });

  it('a host-declared not_applicable is human_required', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ action: { applicability: { status: 'not_applicable', reasons: ['no matching rule'] } } }),
    );
    const factor = verdictOf(decision, 'applicability');
    strictEqual(factor.verdict, 'human_required');
    strictEqual(factor.reasons.includes('no matching rule'), true);
  });

  it('unknown applicability is incomplete', () => {
    const decision = run(basePolicy(), baseRequest({ action: { applicability: { status: 'unknown' } } }));
    strictEqual(verdictOf(decision, 'applicability').verdict, 'incomplete');
  });
});

describe('authority', () => {
  it('a dimension outside non_human_may_hold is withheld → human_required', () => {
    const decision = run(basePolicy(), baseRequest({ action: { requested_dimensions: ['authorize'] } }));
    const factor = verdictOf(decision, 'authority');
    strictEqual(factor.verdict, 'human_required');
    deepStrictEqual(decision.withheld_dimensions, ['authorize']);
  });

  it('a human actor holds their own agency, so authority is satisfied', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        action: {
          requested_dimensions: ['authorize'],
          proposed_by: { actor_id: 'human:alice', actor_kind: 'human' },
        },
      }),
    );
    strictEqual(verdictOf(decision, 'authority').verdict, 'satisfied');
    strictEqual(decision.outcome, 'auto_apply');
  });

  it('human_reserved withholds a dimension even when non_human_may_hold lists it', () => {
    const policy = basePolicy({
      authority: {
        non_human_may_hold: ['project', 'execute', 'learn'],
        human_reserved: ['learn'],
      },
    });
    const decision = run(policy, baseRequest({ action: { requested_dimensions: ['project', 'learn'] } }));
    const factor = verdictOf(decision, 'authority');
    strictEqual(factor.verdict, 'human_required');
    deepStrictEqual(factor.reasons, [`policy.authority.human_reserved includes 'learn'`]);
  });

  it('authorize may be delegated when the policy says so with a rationale', () => {
    const policy = basePolicy({
      authority: {
        non_human_may_hold: ['project', 'execute', 'authorize'],
        authorize_delegation_rationale: 'refunds under $10 are pre-approved by finance',
      },
    });
    const decision = run(policy, baseRequest({ action: { requested_dimensions: ['authorize'] } }));
    strictEqual(verdictOf(decision, 'authority').verdict, 'satisfied');
  });

  it('deterministic actors are non-human too', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        action: {
          requested_dimensions: ['authorize'],
          proposed_by: { actor_id: 'script-1', actor_kind: 'deterministic' },
        },
      }),
    );
    strictEqual(verdictOf(decision, 'authority').verdict, 'human_required');
  });
});

describe('evidence', () => {
  it('no evidence at all is incomplete, not human_required', () => {
    const decision = run(basePolicy(), baseRequest({ evidence_state: { items: [] } }));
    strictEqual(verdictOf(decision, 'evidence').verdict, 'incomplete');
    strictEqual(decision.outcome, 'incomplete');
  });

  it('a single failed evidence item is human_required', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        evidence_state: {
          items: [passingEvidence(), passingEvidence({ evidence_id: 'ev-fail', outcome: 'failed' })],
        },
      }),
    );
    const factor = verdictOf(decision, 'evidence');
    strictEqual(factor.verdict, 'human_required');
    match(factor.reasons.join(' '), /known failure is never auto-applied/);
    strictEqual(decision.outcome, 'human_required');
  });

  it('inconclusive is never rounded up to passed', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ outcome: 'inconclusive' })] } }),
    );
    strictEqual(verdictOf(decision, 'evidence').verdict, 'incomplete');
  });

  it('assurance below minimum_assurance does not count', () => {
    const policy = basePolicy({
      evidence: {
        required: true,
        accepted_modes: ['executable_test'],
        minimum_count: 1,
        minimum_assurance: 'bounded_checked',
      },
    });
    const decision = run(
      policy,
      baseRequest({ evidence_state: { items: [passingEvidence({ assurance: 'evaluator_supported' })] } }),
    );
    const factor = verdictOf(decision, 'evidence');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons.join(' '), /below policy\.evidence\.minimum_assurance/);
    deepStrictEqual(factor.evidence_ids, []);
  });

  it('a mode outside accepted_modes does not count', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ mode: 'llm_judgement' })] } }),
    );
    const factor = verdictOf(decision, 'evidence');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons.join(' '), /not in policy\.evidence\.accepted_modes/);
  });

  it('minimum_count above one is enforced', () => {
    const policy = basePolicy({
      evidence: { required: true, accepted_modes: ['executable_test'], minimum_count: 2 },
    });
    strictEqual(
      verdictOf(run(policy, baseRequest()), 'evidence').verdict,
      'incomplete',
    );
    const twoItems = run(
      policy,
      baseRequest({
        evidence_state: { items: [passingEvidence(), passingEvidence({ evidence_id: 'ev-2' })] },
      }),
    );
    strictEqual(verdictOf(twoItems, 'evidence').verdict, 'satisfied');
  });

  it('evidence not required leaves the factor satisfied even with no items', () => {
    const policy = basePolicy({ evidence: { required: false, accepted_modes: ['executable_test'] } });
    const decision = run(policy, baseRequest({ evidence_state: { items: [] } }));
    strictEqual(verdictOf(decision, 'evidence').verdict, 'satisfied');
  });
});

describe('freshness', () => {
  it('untolerated staleness is incomplete', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'stale', reasons: ['target_changed'] } })],
        },
      }),
    );
    const factor = verdictOf(decision, 'freshness');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons[0]!, /is not in tolerated_staleness_reasons/);
  });

  it('tolerated staleness is satisfied', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'stale', reasons: ['extractor_changed'] } })],
        },
      }),
    );
    strictEqual(verdictOf(decision, 'freshness').verdict, 'satisfied');
    strictEqual(decision.outcome, 'auto_apply');
  });

  it('stale with no stated reason is incomplete (the reason is unknown)', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ freshness: { status: 'stale' } })] } }),
    );
    const factor = verdictOf(decision, 'freshness');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons[0]!, /stale with no reason given/);
  });

  it('unknown freshness is incomplete', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ freshness: { status: 'unknown' } })] } }),
    );
    strictEqual(verdictOf(decision, 'freshness').verdict, 'incomplete');
  });

  it('evidence older than max_age_seconds is incomplete', () => {
    const decision = run(
      basePolicy(),
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'fresh', observed_at: '2026-08-08T09:00:00Z' } })],
        },
      }),
    );
    const factor = verdictOf(decision, 'freshness');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons[0]!, /exceeding policy\.freshness\.max_age_seconds/);
  });

  it('require_fresh=false leaves stale evidence satisfied', () => {
    const policy = basePolicy({ freshness: { require_fresh: false } });
    const decision = run(
      policy,
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'stale', reasons: ['target_changed'] } })],
        },
      }),
    );
    strictEqual(verdictOf(decision, 'freshness').verdict, 'satisfied');
  });
});

describe('risk', () => {
  it('impact over max_impact is human_required', () => {
    const decision = run(basePolicy(), baseRequest({ action: { risk: { impact: 'high' } } }));
    const factor = verdictOf(decision, 'risk');
    strictEqual(factor.verdict, 'human_required');
    match(factor.reasons[0]!, /exceeds policy\.risk\.max_impact/);
  });

  it('exposure over max_exposure is human_required', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'low', exposure: 0.9, uncertainty: 0.05 } } }),
    );
    strictEqual(verdictOf(decision, 'risk').verdict, 'human_required');
  });

  it('uncertainty over max_uncertainty is incomplete, NOT human_required', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'low', exposure: 0.1, uncertainty: 0.9 } } }),
    );
    const factor = verdictOf(decision, 'risk');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons[0]!, /the boundary cannot be computed/);
    strictEqual(decision.outcome, 'incomplete');
  });

  it('a missing measurement against a declared ceiling is incomplete', () => {
    const decision = run(basePolicy(), baseRequest({ action: { risk: { impact: 'low' } } }));
    const factor = verdictOf(decision, 'risk');
    strictEqual(factor.verdict, 'incomplete');
    strictEqual(factor.reasons.length, 2); // exposure and uncertainty both unevaluable
  });

  it('within a single factor, human_required still beats incomplete', () => {
    const decision = run(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'critical', exposure: 0.1, uncertainty: 0.9 } } }),
    );
    const factor = verdictOf(decision, 'risk');
    strictEqual(factor.verdict, 'human_required');
    strictEqual(factor.reasons.length, 2);
  });
});

describe('reversibility', () => {
  it('irreversible is always human_required', () => {
    const policy = basePolicy({ reversibility: { minimum: 'compensatable' } });
    const decision = run(policy, baseRequest({ action: { reversibility: 'irreversible' } }));
    strictEqual(verdictOf(decision, 'reversibility').verdict, 'human_required');
  });

  it('unknown is incomplete and is never treated as reversible', () => {
    const decision = run(basePolicy(), baseRequest({ action: { reversibility: 'unknown' } }));
    const factor = verdictOf(decision, 'reversibility');
    strictEqual(factor.verdict, 'incomplete');
    match(factor.reasons[0]!, /must not be treated as reversible/);
  });

  it('compensatable falls below a reversible minimum → human_required', () => {
    const decision = run(basePolicy(), baseRequest({ action: { reversibility: 'compensatable' } }));
    strictEqual(verdictOf(decision, 'reversibility').verdict, 'human_required');
  });

  it('compensatable meets a compensatable minimum', () => {
    const policy = basePolicy({ reversibility: { minimum: 'compensatable' } });
    const decision = run(policy, baseRequest({ action: { reversibility: 'compensatable' } }));
    strictEqual(verdictOf(decision, 'reversibility').verdict, 'satisfied');
  });
});

describe('routing', () => {
  it('an incomplete decision always names what to observe next', () => {
    const cases: Request[] = [
      baseRequest({ evidence_state: { items: [] } }),
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'stale', reasons: ['target_changed'] } })],
        },
      }),
      baseRequest({ action: { reversibility: 'unknown' } }),
      baseRequest({ action: { applicability: { status: 'capability_missing' } } }),
      baseRequest({ action: { risk: { impact: 'low', exposure: 0.1, uncertainty: 0.9 } } }),
    ];
    for (const request of cases) {
      const decision = run(basePolicy(), request);
      strictEqual(decision.outcome, 'incomplete');
      strictEqual(
        (decision.routing?.required_evidence_modes ?? []).length > 0,
        true,
        `no required_evidence_modes for ${JSON.stringify(request.action.action_id)}`,
      );
    }
  });

  it('stale evidence points back at the mode that went stale', () => {
    const policy = basePolicy({
      evidence: {
        required: true,
        accepted_modes: ['executable_test', 'static_verification'],
        minimum_count: 1,
      },
    });
    const decision = run(
      policy,
      baseRequest({
        evidence_state: {
          items: [passingEvidence({ freshness: { status: 'stale', reasons: ['target_changed'] } })],
        },
      }),
    );
    deepStrictEqual(decision.routing?.required_evidence_modes, ['executable_test']);
  });

  it('a non-incomplete decision carries no required_evidence_modes', () => {
    deepStrictEqual(run(basePolicy(), baseRequest()).routing, {});
  });
});

describe('purity', () => {
  it('the same inputs always produce the same decision', () => {
    const policy = basePolicy();
    const request = baseRequest();
    deepStrictEqual(run(policy, request), run(policy, request));
  });

  it('decide() does not mutate its inputs', () => {
    const policy = basePolicy();
    const request = baseRequest();
    const before = JSON.stringify({ policy, request });
    run(policy, request);
    strictEqual(JSON.stringify({ policy, request }), before);
  });
});
