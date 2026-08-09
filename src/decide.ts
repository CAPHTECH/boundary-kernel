/**
 * The boundary computation (design §3–4).
 *
 * `decide()` is a synchronous pure function. Digests are passed in rather than
 * computed here so the kernel never depends on an async crypto API and so
 * every branch is trivially testable. The only hashing that happens inside is
 * `decision_id`, which uses the dependency-free synchronous SHA-256 in
 * `sha256.ts` (byte-identical to the Web Crypto path in `digest.ts`).
 *
 * Composition rule — the asymmetry is the whole point:
 *
 *     any factor human_required        → human_required
 *     otherwise, any factor incomplete → incomplete
 *     all satisfied                    → auto_apply
 *
 * `incomplete` is never collapsed into `human_required`: the former says
 * "this might have been auto-appliable but we cannot show it", which is a
 * signal about missing measurement infrastructure. Collapsing it hides that
 * gap permanently.
 */

import { decisionIdPreimage } from './digest.ts';
import { sha256Utf8 } from './sha256.ts';
import {
  ASSURANCE_ORDER,
  SEVERITY_ORDER,
  type AgencyDimension,
  type AssuranceLevel,
  type Decision,
  type EvidenceItem,
  type FactorVerdict,
  type Outcome,
  type Policy,
  type Request,
  type RequestDigests,
  type Semver,
  type Severity,
  type Verdict,
} from './types.ts';

export const KERNEL_VERSION: Semver = '0.1.0';

export interface DecideOptions {
  /**
   * Timestamp written to `computed_at`. Supply it to keep `decide()` fully
   * pure and deterministic; omitting it falls back to the wall clock.
   */
  computed_at?: string;
  kernel_version?: Semver;
}

export function decide(
  policy: Policy,
  request: Request,
  digests: RequestDigests,
  options: DecideOptions = {},
): Decision {
  const action = request.action;
  const requested = action.requested_dimensions;

  // The evidence a verdict is allowed to lean on. Computed once so that the
  // `evidence` and `freshness` factors judge exactly the same items.
  const qualifying = qualifyingEvidence(policy, request.evidence_state.items);

  const applicability = evaluateApplicability(policy, request);
  const authority = evaluateAuthority(policy, request);
  const evidence = evaluateEvidence(policy, request, qualifying);
  const freshness = evaluateFreshness(policy, request, qualifying);
  const risk = evaluateRisk(policy, request);
  const reversibility = evaluateReversibility(policy, request);

  // Order is the schema's factor enum order; all six are always present, and
  // satisfied factors are never omitted (design §6).
  const factors: FactorVerdict[] = [
    applicability,
    authority.verdict_entry,
    evidence,
    freshness.verdict_entry,
    risk,
    reversibility,
  ];

  const outcome = compose(factors.map((f) => f.verdict));

  const decision_id = `sha256:${sha256Utf8(
    decisionIdPreimage({
      action_digest: digests.action_digest,
      evidence_state_digest: digests.evidence_state_digest,
      policy_id: policy.policy_id,
      policy_version: policy.version,
    }),
  )}`;

  const decision: Decision = {
    schema: 'rbk.decision.v1',
    decision_id,
    request_id: request.request_id,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    outcome,
    factors,
    identity: {
      action_digest: digests.action_digest,
      evidence_state_digest: digests.evidence_state_digest,
    },
    routing: {},
    computed_at: options.computed_at ?? new Date().toISOString(),
    kernel_version: options.kernel_version ?? KERNEL_VERSION,
  };

  if (outcome === 'auto_apply') {
    // Monotone narrowing: what is granted can only be a subset of what was
    // requested, and nothing is withheld.
    decision.granted_dimensions = [...requested];
    decision.withheld_dimensions = [];
  } else {
    // The boundary did not open. No dimension passes to the non-human actor,
    // whichever factor was responsible.
    decision.withheld_dimensions = [...requested];
  }

  if (outcome === 'incomplete') {
    // "What should be observed next" is mandatory — a decision that cannot say
    // it has no business calling itself incomplete (decision schema allOf[0]).
    decision.routing = {
      required_evidence_modes: requiredEvidenceModes(policy, factors, freshness.unresolved_modes),
    };
  }

  return decision;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** human_required > incomplete > auto_apply (design §3). */
export function compose(verdicts: readonly Verdict[]): Outcome {
  if (verdicts.includes('human_required')) return 'human_required';
  if (verdicts.includes('incomplete')) return 'incomplete';
  return 'auto_apply';
}

/** The same asymmetry applied inside a single factor. */
function worst(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes('human_required')) return 'human_required';
  if (verdicts.includes('incomplete')) return 'incomplete';
  return 'satisfied';
}

// ---------------------------------------------------------------------------
// applicability — sdde discipline: capability_missing ≠ not_applicable
// ---------------------------------------------------------------------------

function evaluateApplicability(policy: Policy, request: Request): FactorVerdict {
  const action = request.action;
  const reasons: string[] = [];
  const verdicts: Verdict[] = [];

  if (!policy.scope.action_kinds.includes(action.action_kind)) {
    verdicts.push('human_required');
    reasons.push(
      `action_kind '${action.action_kind}' is not in policy.scope.action_kinds; ` +
        `this policy is not_applicable to the action`,
    );
  }

  // `domains` is an optional narrowing. A stated domain outside the policy's
  // list is out of scope; an unstated domain adds no constraint.
  if (policy.scope.domains && action.domain !== undefined && !policy.scope.domains.includes(action.domain)) {
    verdicts.push('human_required');
    reasons.push(`action.domain '${action.domain}' is not in policy.scope.domains`);
  }

  const declared = action.applicability;
  if (declared) {
    const hostReasons = declared.reasons ?? [];
    switch (declared.status) {
      case 'applicable':
        break;
      case 'not_applicable':
        verdicts.push('human_required');
        reasons.push(`request.action.applicability.status is 'not_applicable'`, ...hostReasons);
        break;
      case 'capability_missing':
        verdicts.push('incomplete');
        reasons.push(
          `request.action.applicability.status is 'capability_missing'; ` +
            `the capability needed to judge applicability is absent, which is not the same as not_applicable`,
          ...hostReasons,
        );
        break;
      case 'unknown':
        verdicts.push('incomplete');
        reasons.push(
          `request.action.applicability.status is 'unknown'; applicability was not determined`,
          ...hostReasons,
        );
        break;
    }
  }

  return { factor: 'applicability', verdict: worst(verdicts), reasons };
}

// ---------------------------------------------------------------------------
// authority — GAE agency dimensions
// ---------------------------------------------------------------------------

interface AuthorityResult {
  verdict_entry: FactorVerdict;
  withheld: AgencyDimension[];
}

function evaluateAuthority(policy: Policy, request: Request): AuthorityResult {
  const action = request.action;

  // A human performing the act holds their own agency; the policy's ceiling
  // constrains what *non-humans* may hold (policy.authority.non_human_may_hold).
  if (action.proposed_by.actor_kind === 'human') {
    return {
      verdict_entry: { factor: 'authority', verdict: 'satisfied', reasons: [] },
      withheld: [],
    };
  }

  const mayHold = policy.authority.non_human_may_hold;
  const reserved = policy.authority.human_reserved ?? [];
  const rationale = policy.authority.authorize_delegation_rationale;

  const reasons: string[] = [];
  const withheld: AgencyDimension[] = [];

  for (const dimension of action.requested_dimensions) {
    const dimensionReasons: string[] = [];

    if (!mayHold.includes(dimension)) {
      dimensionReasons.push(
        `requested dimension '${dimension}' is not in policy.authority.non_human_may_hold`,
      );
    }
    if (reserved.includes(dimension)) {
      // human_reserved is absolute: it withholds even a dimension that also
      // appears in non_human_may_hold.
      dimensionReasons.push(
        dimension === 'authorize' && rationale === undefined
          ? `policy.authority.human_reserved includes 'authorize' and no authorize_delegation_rationale is present`
          : `policy.authority.human_reserved includes '${dimension}'`,
      );
    }

    if (dimensionReasons.length > 0) {
      withheld.push(dimension);
      reasons.push(...dimensionReasons);
    }
  }

  return {
    verdict_entry: {
      factor: 'authority',
      verdict: withheld.length > 0 ? 'human_required' : 'satisfied',
      reasons,
    },
    withheld,
  };
}

// ---------------------------------------------------------------------------
// evidence — absence is incomplete, known failure is human_required
// ---------------------------------------------------------------------------

const assuranceRank = (level: AssuranceLevel): number => ASSURANCE_ORDER.indexOf(level);
const severityRank = (level: Severity): number => SEVERITY_ORDER.indexOf(level);

function qualifyingEvidence(policy: Policy, items: readonly EvidenceItem[]): EvidenceItem[] {
  const minimum = policy.evidence.minimum_assurance;
  return items.filter(
    (item) =>
      policy.evidence.accepted_modes.includes(item.mode) &&
      item.outcome === 'passed' &&
      (minimum === undefined || assuranceRank(item.assurance) >= assuranceRank(minimum)),
  );
}

function evaluateEvidence(
  policy: Policy,
  request: Request,
  qualifying: readonly EvidenceItem[],
): FactorVerdict {
  const items = request.evidence_state.items;
  const reasons: string[] = [];
  const verdicts: Verdict[] = [];

  // A known failure is a settled fact, not a missing measurement — it holds
  // regardless of whether the policy requires evidence at all.
  const failed = items.filter((item) => item.outcome === 'failed');
  for (const item of failed) {
    verdicts.push('human_required');
    reasons.push(
      `evidence ${item.evidence_id} (mode '${item.mode}') has outcome 'failed'; ` +
        `a known failure is never auto-applied`,
    );
  }

  if (policy.evidence.required) {
    const minimumCount = policy.evidence.minimum_count ?? 1;
    if (qualifying.length < minimumCount) {
      verdicts.push('incomplete');
      reasons.push(
        `${qualifying.length} of ${minimumCount} required evidence item(s) satisfy policy.evidence ` +
          `(accepted_modes=[${policy.evidence.accepted_modes.join(', ')}], outcome=passed` +
          (policy.evidence.minimum_assurance
            ? `, minimum_assurance=${policy.evidence.minimum_assurance}`
            : '') +
          `)`,
      );
      // Name the near misses: a bare count hides which axis was short.
      for (const item of items) {
        if (qualifying.includes(item) || item.outcome === 'failed') continue;
        reasons.push(nearMissReason(policy, item));
      }
    }
  }

  return {
    factor: 'evidence',
    verdict: worst(verdicts),
    reasons,
    evidence_ids: qualifying.map((item) => item.evidence_id),
  };
}

function nearMissReason(policy: Policy, item: EvidenceItem): string {
  if (!policy.evidence.accepted_modes.includes(item.mode)) {
    return `evidence ${item.evidence_id} has mode '${item.mode}', which is not in policy.evidence.accepted_modes`;
  }
  if (item.outcome !== 'passed') {
    return `evidence ${item.evidence_id} has outcome '${item.outcome}', which is not 'passed'`;
  }
  return (
    `evidence ${item.evidence_id} has assurance '${item.assurance}', ` +
    `below policy.evidence.minimum_assurance '${policy.evidence.minimum_assurance}'`
  );
}

// ---------------------------------------------------------------------------
// freshness — staleness of the evidence the verdict actually leaned on
// ---------------------------------------------------------------------------

interface FreshnessResult {
  verdict_entry: FactorVerdict;
  /** Modes of the items that blocked freshness — what has to be re-observed. */
  unresolved_modes: string[];
}

function evaluateFreshness(
  policy: Policy,
  request: Request,
  qualifying: readonly EvidenceItem[],
): FreshnessResult {
  const evidence_ids = qualifying.map((item) => item.evidence_id);

  if (!policy.freshness.require_fresh) {
    return {
      verdict_entry: { factor: 'freshness', verdict: 'satisfied', reasons: [], evidence_ids },
      unresolved_modes: [],
    };
  }

  const tolerated = policy.freshness.tolerated_staleness_reasons ?? [];
  const reasons: string[] = [];
  const verdicts: Verdict[] = [];
  const unresolved = new Set<string>();

  for (const item of qualifying) {
    const { status, reasons: stalenessReasons } = item.freshness;

    if (status === 'unknown') {
      verdicts.push('incomplete');
      unresolved.add(item.mode);
      reasons.push(
        `evidence ${item.evidence_id} has freshness.status 'unknown'; ` +
          `policy.freshness.require_fresh=true and unknown is not fresh`,
      );
      continue;
    }

    if (status === 'stale') {
      if (!stalenessReasons || stalenessReasons.length === 0) {
        verdicts.push('incomplete');
        unresolved.add(item.mode);
        reasons.push(
          `evidence ${item.evidence_id} is stale with no reason given; ` +
            `the staleness cannot be checked against policy.freshness.tolerated_staleness_reasons`,
        );
        continue;
      }
      const untolerated = stalenessReasons.filter((reason) => !tolerated.includes(reason));
      if (untolerated.length > 0) {
        verdicts.push('incomplete');
        unresolved.add(item.mode);
        reasons.push(
          `evidence ${item.evidence_id} is stale (${stalenessReasons.join(', ')}); ` +
            `policy.freshness.require_fresh=true and ${untolerated.join(', ')} ` +
            `${untolerated.length === 1 ? 'is' : 'are'} not in tolerated_staleness_reasons`,
        );
      }
      continue;
    }

    // status === 'fresh': cross-check the age when both timestamps are known.
    // An absent timestamp is not treated as staleness — the host has asserted
    // freshness, and max_age_seconds is a secondary check, not the primary one.
    const age = ageSeconds(item, request);
    if (policy.freshness.max_age_seconds !== undefined && age !== undefined) {
      if (age > policy.freshness.max_age_seconds) {
        verdicts.push('incomplete');
        unresolved.add(item.mode);
        reasons.push(
          `evidence ${item.evidence_id} is ${age}s old, exceeding ` +
            `policy.freshness.max_age_seconds ${policy.freshness.max_age_seconds}`,
        );
      }
    }
  }

  return {
    verdict_entry: { factor: 'freshness', verdict: worst(verdicts), reasons, evidence_ids },
    unresolved_modes: [...unresolved],
  };
}

function ageSeconds(item: EvidenceItem, request: Request): number | undefined {
  const observed = item.freshness.observed_at;
  const now = request.observed_at;
  if (observed === undefined || now === undefined) return undefined;
  const from = Date.parse(observed);
  const to = Date.parse(now);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return Math.max(0, Math.round((to - from) / 1000));
}

// ---------------------------------------------------------------------------
// risk — impact/exposure narrow the boundary, uncertainty blocks the computation
// ---------------------------------------------------------------------------

function evaluateRisk(policy: Policy, request: Request): FactorVerdict {
  const risk = request.action.risk;
  const reasons: string[] = [];
  const verdicts: Verdict[] = [];

  if (severityRank(risk.impact) > severityRank(policy.risk.max_impact)) {
    verdicts.push('human_required');
    reasons.push(
      `action.risk.impact '${risk.impact}' exceeds policy.risk.max_impact '${policy.risk.max_impact}'`,
    );
  }

  if (policy.risk.max_exposure !== undefined) {
    if (risk.exposure === undefined) {
      verdicts.push('incomplete');
      reasons.push(
        `action.risk.exposure is absent but policy.risk.max_exposure is ${policy.risk.max_exposure}; ` +
          `exposure cannot be evaluated`,
      );
    } else if (risk.exposure > policy.risk.max_exposure) {
      verdicts.push('human_required');
      reasons.push(
        `action.risk.exposure ${risk.exposure} exceeds policy.risk.max_exposure ${policy.risk.max_exposure}`,
      );
    }
  }

  if (policy.risk.max_uncertainty !== undefined) {
    if (risk.uncertainty === undefined) {
      verdicts.push('incomplete');
      reasons.push(
        `action.risk.uncertainty is absent but policy.risk.max_uncertainty is ${policy.risk.max_uncertainty}; ` +
          `uncertainty cannot be evaluated`,
      );
    } else if (risk.uncertainty > policy.risk.max_uncertainty) {
      // Deliberately incomplete, not human_required: too much uncertainty means
      // the boundary cannot be computed (policy schema, max_uncertainty note).
      verdicts.push('incomplete');
      reasons.push(
        `action.risk.uncertainty ${risk.uncertainty} exceeds policy.risk.max_uncertainty ` +
          `${policy.risk.max_uncertainty}; the boundary cannot be computed`,
      );
    }
  }

  return { factor: 'risk', verdict: worst(verdicts), reasons };
}

// ---------------------------------------------------------------------------
// reversibility — Rollback Fiction ban
// ---------------------------------------------------------------------------

function evaluateReversibility(policy: Policy, request: Request): FactorVerdict {
  const actual = request.action.reversibility;
  const minimum = policy.reversibility.minimum;

  switch (actual) {
    case 'irreversible':
      return {
        factor: 'reversibility',
        verdict: 'human_required',
        reasons: [
          `action.reversibility is 'irreversible'; an irreversible action is never auto-applied`,
        ],
      };
    case 'unknown':
      return {
        factor: 'reversibility',
        verdict: 'incomplete',
        reasons: [
          `action.reversibility is 'unknown'; unknown must not be treated as reversible`,
        ],
      };
    case 'compensatable':
      if (minimum === 'reversible') {
        return {
          factor: 'reversibility',
          verdict: 'human_required',
          reasons: [
            `action.reversibility 'compensatable' does not meet policy.reversibility.minimum 'reversible'`,
          ],
        };
      }
      return { factor: 'reversibility', verdict: 'satisfied', reasons: [] };
    case 'reversible':
      return { factor: 'reversibility', verdict: 'satisfied', reasons: [] };
  }
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * What would have to be observed to resolve the `incomplete`. Freshness
 * contributes the modes of the very items that went stale (re-run those);
 * anything else falls back to the policy's accepted modes.
 */
function requiredEvidenceModes(
  policy: Policy,
  factors: readonly FactorVerdict[],
  freshnessUnresolvedModes: readonly string[],
): string[] {
  const modes = new Set<string>(freshnessUnresolvedModes);

  const otherIncomplete = factors.some(
    (factor) => factor.factor !== 'freshness' && factor.verdict === 'incomplete',
  );
  if (otherIncomplete || modes.size === 0) {
    for (const mode of policy.evidence.accepted_modes) modes.add(mode);
  }

  return [...modes];
}
