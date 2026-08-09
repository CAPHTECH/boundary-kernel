import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attribute } from '../src/attribute.ts';
import { decide } from '../src/decide.ts';
import type { Decision, RequestDigests } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS } from './builders.ts';

const OTHER: RequestDigests = {
  action_digest: `sha256:${'c'.repeat(64)}`,
  evidence_state_digest: `sha256:${'d'.repeat(64)}`,
};

const base = (): Decision => decide(basePolicy(), baseRequest(), DIGESTS, { computed_at: AT });

describe('attribute', () => {
  it('no change at all', () => {
    const result = attribute(base(), base());
    strictEqual(result.cause, 'no_change');
    deepStrictEqual(result.changed_components, []);
    strictEqual(result.outcome_transition, undefined);
    strictEqual(result.compared_to_decision_id, base().decision_id);
  });

  it('action change only', () => {
    const next = decide(
      basePolicy(),
      baseRequest(),
      { ...DIGESTS, action_digest: OTHER.action_digest },
      { computed_at: AT },
    );
    const result = attribute(base(), next);
    strictEqual(result.cause, 'action_change');
    deepStrictEqual(result.changed_components, ['action_digest']);
  });

  it('evidence change only', () => {
    const next = decide(
      basePolicy(),
      baseRequest(),
      { ...DIGESTS, evidence_state_digest: OTHER.evidence_state_digest },
      { computed_at: AT },
    );
    const result = attribute(base(), next);
    strictEqual(result.cause, 'evidence_change');
    deepStrictEqual(result.changed_components, ['evidence_state_digest']);
  });

  it('policy change only — same evidence, different policy', () => {
    const next = decide(
      basePolicy({ policy_id: 'stricter-policy', risk: { max_impact: 'none' } }),
      baseRequest(),
      DIGESTS,
      { computed_at: AT },
    );
    const result = attribute(base(), next);
    strictEqual(result.cause, 'policy_change');
    deepStrictEqual(result.changed_components, ['policy_id']);
    // The policy change must never be reported as an evidence change (design §6).
    strictEqual(result.changed_components?.includes('evidence_state_digest'), false);
    deepStrictEqual(result.outcome_transition, { from: 'auto_apply', to: 'human_required' });
  });

  it('policy_id and policy_version together are still one policy change', () => {
    const next = decide(
      basePolicy({ policy_id: 'stricter-policy', version: '2.0.0' }),
      baseRequest(),
      DIGESTS,
      { computed_at: AT },
    );
    const result = attribute(base(), next);
    strictEqual(result.cause, 'policy_change');
    deepStrictEqual(result.changed_components, ['policy_id', 'policy_version']);
  });

  it('a version bump alone is a policy change', () => {
    const next = decide(basePolicy({ version: '1.1.0' }), baseRequest(), DIGESTS, { computed_at: AT });
    strictEqual(attribute(base(), next).cause, 'policy_change');
  });

  it('multiple components across categories → unattributable, never a guess', () => {
    const next = decide(
      basePolicy({ policy_id: 'other-policy' }),
      baseRequest(),
      OTHER,
      { computed_at: AT },
    );
    const result = attribute(base(), next);
    strictEqual(result.cause, 'unattributable');
    deepStrictEqual(result.changed_components, [
      'action_digest',
      'evidence_state_digest',
      'policy_id',
    ]);
  });

  it('action + evidence together is also unattributable', () => {
    const next = decide(basePolicy(), baseRequest(), OTHER, { computed_at: AT });
    strictEqual(attribute(base(), next).cause, 'unattributable');
  });

  it('records the outcome transition when the boundary moves', () => {
    const prev = base();
    const next = decide(
      basePolicy(),
      baseRequest({ action: { reversibility: 'unknown' } }),
      { ...DIGESTS, action_digest: OTHER.action_digest },
      { computed_at: AT },
    );
    deepStrictEqual(attribute(prev, next).outcome_transition, {
      from: 'auto_apply',
      to: 'incomplete',
    });
  });
});
