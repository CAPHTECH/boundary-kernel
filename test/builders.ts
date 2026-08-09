import type { EvidenceItem, Policy, Request, RequestDigests } from '../src/types.ts';

/** A policy under which the base request below is fully satisfied. */
export function basePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    schema: 'rbk.policy.v1',
    policy_id: 'test-policy',
    version: '1.0.0',
    scope: { action_kinds: ['code.patch'], domains: ['test'] },
    authority: {
      non_human_may_hold: ['observe', 'frame', 'project', 'judge', 'execute'],
      human_reserved: ['authorize', 'learn'],
    },
    evidence: {
      required: true,
      accepted_modes: ['executable_test'],
      minimum_count: 1,
      minimum_assurance: 'runtime_observed',
    },
    freshness: {
      require_fresh: true,
      max_age_seconds: 3600,
      tolerated_staleness_reasons: ['extractor_changed'],
    },
    risk: { max_impact: 'medium', max_exposure: 0.5, max_uncertainty: 0.3 },
    reversibility: { minimum: 'reversible' },
    ...overrides,
  };
}

export function passingEvidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    evidence_id: 'ev-base',
    mode: 'executable_test',
    outcome: 'passed',
    assurance: 'runtime_observed',
    freshness: { status: 'fresh', observed_at: '2026-08-09T09:00:00Z' },
    ...overrides,
  };
}

/** A request that yields auto_apply under `basePolicy()`. */
export function baseRequest(overrides: {
  action?: Partial<Request['action']>;
  evidence_state?: Request['evidence_state'];
  observed_at?: string;
} = {}): Request {
  return {
    schema: 'rbk.request.v1',
    request_id: 'req-test',
    action: {
      action_id: 'action-test',
      action_kind: 'code.patch',
      domain: 'test',
      proposed_by: { actor_id: 'agent-test', actor_kind: 'ai_agent' },
      requested_dimensions: ['project', 'execute'],
      reversibility: 'reversible',
      risk: { impact: 'low', exposure: 0.1, uncertainty: 0.05 },
      applicability: { status: 'applicable' },
      ...overrides.action,
    },
    evidence_state: overrides.evidence_state ?? { items: [passingEvidence()] },
    observed_at: overrides.observed_at ?? '2026-08-09T09:05:00Z',
  };
}

export const DIGESTS: RequestDigests = {
  action_digest: `sha256:${'a'.repeat(64)}`,
  evidence_state_digest: `sha256:${'b'.repeat(64)}`,
};

export const AT = '2026-08-09T09:05:01Z';
