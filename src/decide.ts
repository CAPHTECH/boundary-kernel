/**
 * The boundary computation (design §3–4).
 *
 * `decide()` is a synchronous pure function. Digests are passed in rather than
 * computed here so the kernel never depends on an async crypto API and so
 * every branch is trivially testable. The hashing that does happen inside —
 * `policy_digest` and `decision_id` — uses the dependency-free synchronous
 * SHA-256 in `sha256.ts` (byte-identical to the Web Crypto path in
 * `digest.ts`). The policy is hashed here rather than passed in because the
 * kernel holds the policy already, and because an identity that depends on the
 * host's own digest of the policy would not bind the policy at all.
 *
 * Two axes, not one (design §3, corrected in v0.2):
 *
 *   routing — where the action goes
 *     any factor human_required        → human_required
 *     otherwise, any factor incomplete → incomplete
 *     all satisfied                    → auto_apply
 *
 *   measurement — was our evidential basis sufficient
 *     any factor raised an incomplete signal → basis_complete = false
 *
 * v0.1 folded both questions into the single three-valued `outcome`, so a
 * `human_required` factor silently discarded a co-occurring `incomplete` —
 * exactly the collapse the design forbids. The two are independently true:
 * "a human must decide" and "our basis was also short" happen together.
 *
 * `outcome === 'incomplete'` is therefore not a separate rule but the special
 * case `basis_complete === false` with no `human_required` factor; the basis
 * gap is recorded whatever the routing says.
 */

import { decisionIdPreimage, policyDigestPreimage } from './digest.ts';
import { normalizeAction, normalizeEvidenceState, sortStrings } from './normalize.ts';
import { sha256Utf8 } from './sha256.ts';
import {
  ASSURANCE_ORDER,
  DECISION_SCHEMA,
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
  type FactorKind,
  type Semver,
  type Severity,
  type Verdict,
} from './types.ts';
import { validateInputs, type InputDefect } from './validate.ts';

export const KERNEL_VERSION: Semver = '0.4.0';

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
  // Before anything is normalized or compared: every value this function is
  // about to branch on has to be inside the domain its schema declares. A value
  // that is not cannot be placed relative to the policy, and an input the kernel
  // cannot read must never resolve to `auto_apply` — see `validate.ts`.
  // Unreadable *shape* throws from here; out-of-domain values come back as
  // defects and become `human_required` factors below.
  const undecidable = defectsByFactor(validateInputs(policy, request));

  // Sets are judged in canonical order, so that two requests differing only in
  // the order of a set produce a byte-identical decision — not just an equal
  // digest (design §5, `normalize.ts`).
  const normalized: Request = {
    ...request,
    action: normalizeAction(request.action),
    evidence_state: normalizeEvidenceState(request.evidence_state),
  };
  const action = normalized.action;
  const requested = action.requested_dimensions;

  // The evidence a verdict is allowed to lean on. Computed once so that the
  // `evidence` and `freshness` factors judge exactly the same items.
  const qualifying = qualifyingEvidence(policy, normalized.evidence_state.items);

  // A factor whose inputs did not survive validation is not evaluated: there is
  // nothing to evaluate them against. It reports what it could not read instead.
  const applicability =
    undecidable.get('applicability') ?? evaluateApplicability(policy, normalized);
  const authority =
    undecidable.get('authority') ?? evaluateAuthority(policy, normalized).verdict_entry;
  const evidence = undecidable.get('evidence') ?? evaluateEvidence(policy, normalized, qualifying);
  const undecidableFreshness = undecidable.get('freshness');
  const freshnessResult = undecidableFreshness
    ? undefined
    : evaluateFreshness(policy, normalized, qualifying);
  const freshness = undecidableFreshness ?? freshnessResult!.verdict_entry;
  const risk = undecidable.get('risk') ?? evaluateRisk(policy, normalized);
  const reversibility =
    undecidable.get('reversibility') ?? evaluateReversibility(policy, normalized);

  // Order is the schema's factor enum order; all six are always present, and
  // satisfied factors are never omitted (design §6).
  const factors: FactorVerdict[] = [
    applicability,
    authority,
    evidence,
    freshness,
    risk,
    reversibility,
  ];

  const outcome = compose(factors.map((f) => f.verdict));
  const basis_complete = composeBasis(factors);

  // The policy digest is computed here rather than accepted as an argument:
  // it is the one part of the identity that must not depend on the host's
  // discipline, since binding the policy by content is precisely what stops a
  // rewrite behind an unchanged (policy_id, version) from going unnoticed.
  const policy_digest = `sha256:${sha256Utf8(policyDigestPreimage(policy))}`;

  // The schema and the kernel version identify the *computation*; the digests
  // identify its inputs. Both are needed: decisions under two schema versions
  // over identical inputs are different decisions (v1 folded routing into
  // measurement; v2 bound the policy by label only), and a later kernel may
  // draw a different boundary from the same request. Note
  // that this is KERNEL_VERSION, the kernel that actually ran — not
  // `options.kernel_version`, which only relabels the emitted field and must
  // not let a host mint distinct identities for one computation.
  const decision_id = `sha256:${sha256Utf8(
    decisionIdPreimage({
      action_digest: digests.action_digest,
      evidence_state_digest: digests.evidence_state_digest,
      policy_digest,
      policy_id: policy.policy_id,
      policy_version: policy.version,
      decision_schema: DECISION_SCHEMA,
      kernel_version: KERNEL_VERSION,
    }),
  )}`;

  const decision: Decision = {
    schema: DECISION_SCHEMA,
    decision_id,
    request_id: request.request_id,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    outcome,
    basis_complete,
    factors,
    identity: {
      action_digest: digests.action_digest,
      evidence_state_digest: digests.evidence_state_digest,
      policy_digest,
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

  if (!basis_complete) {
    // "What should be observed next" is mandatory whenever the basis is short —
    // not only when the routing happens to be `incomplete`. A human_required
    // decision whose basis was also incomplete must still say what is missing,
    // otherwise the gap is unactionable and we are back to v0.1's collapse
    // (decision schema allOf).
    decision.routing = {
      required_evidence_modes: requiredEvidenceModes(
        policy,
        factors,
        freshnessResult?.unresolved_modes ?? [],
      ),
    };
  }

  return decision;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Turns the validator's defects into the factors that will stand in for the
 * evaluations that could not run.
 *
 * `human_required` on the routing axis and `basis_complete: false` on the
 * measurement axis, together — both are true at once, and the whole point of
 * splitting the axes in v0.2 was that saying one must not erase the other. A
 * person has to look at this (the kernel cannot place the action), *and* our
 * evidential basis was short (we could not read the field). Every reason names
 * the field, the value that arrived and the domain it had to be in, so the
 * decision records why it could not be computed rather than leaving `reasons`
 * empty — which is exactly how the defect this fixes stayed invisible.
 */
function defectsByFactor(defects: readonly InputDefect[]): Map<FactorKind, FactorVerdict> {
  const reasons = new Map<FactorKind, string[]>();
  for (const defect of defects) {
    const existing = reasons.get(defect.factor);
    if (existing) existing.push(defect.reason);
    else reasons.set(defect.factor, [defect.reason]);
  }

  const factors = new Map<FactorKind, FactorVerdict>();
  for (const [factor, factorReasons] of reasons) {
    factors.set(factor, {
      factor,
      verdict: 'human_required',
      basis_complete: false,
      reasons: factorReasons,
    });
  }
  return factors;
}

/** routing axis: human_required > incomplete > auto_apply (design §3). */
export function compose(verdicts: readonly Verdict[]): Outcome {
  if (verdicts.includes('human_required')) return 'human_required';
  if (verdicts.includes('incomplete')) return 'incomplete';
  return 'auto_apply';
}

/**
 * measurement axis: the basis is complete only if no factor reported a gap.
 * Independent of `compose()` by construction — that independence is the fix.
 */
export function composeBasis(factors: readonly Pick<FactorVerdict, 'basis_complete'>[]): boolean {
  return factors.every((factor) => factor.basis_complete);
}

/**
 * Both axes for a single factor, resolved from the signals it raised.
 * `human_required` wins the routing; an `incomplete` signal marks the basis
 * short even when it lost the routing.
 */
function resolve(verdicts: readonly Verdict[]): { verdict: Verdict; basis_complete: boolean } {
  const verdict: Verdict = verdicts.includes('human_required')
    ? 'human_required'
    : verdicts.includes('incomplete')
      ? 'incomplete'
      : 'satisfied';
  return { verdict, basis_complete: !verdicts.includes('incomplete') };
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

  return { factor: 'applicability', ...resolve(verdicts), reasons };
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
      verdict_entry: { factor: 'authority', verdict: 'satisfied', basis_complete: true, reasons: [] },
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
      // Authority is decided from the policy's map alone: it is never short of
      // measurement, only of permission.
      basis_complete: true,
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
    ...resolve(verdicts),
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
      verdict_entry: {
        factor: 'freshness',
        verdict: 'satisfied',
        basis_complete: true,
        reasons: [],
        evidence_ids,
      },
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
    verdict_entry: { factor: 'freshness', ...resolve(verdicts), reasons, evidence_ids },
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

  return { factor: 'risk', ...resolve(verdicts), reasons };
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
        basis_complete: true,
        reasons: [
          `action.reversibility is 'irreversible'; an irreversible action is never auto-applied`,
        ],
      };
    case 'unknown':
      return {
        factor: 'reversibility',
        verdict: 'incomplete',
        basis_complete: false,
        reasons: [
          `action.reversibility is 'unknown'; unknown must not be treated as reversible`,
        ],
      };
    case 'compensatable':
      if (minimum === 'reversible') {
        return {
          factor: 'reversibility',
          verdict: 'human_required',
          basis_complete: true,
          reasons: [
            `action.reversibility 'compensatable' does not meet policy.reversibility.minimum 'reversible'`,
          ],
        };
      }
      return { factor: 'reversibility', verdict: 'satisfied', basis_complete: true, reasons: [] };
    case 'reversible':
      return { factor: 'reversibility', verdict: 'satisfied', basis_complete: true, reasons: [] };
    default:
      // Unreachable via `decide()`, which validates first. Kept so the function
      // is total for any caller: without it a value outside the enum fell off
      // the end and returned `undefined`, and the `undefined` then threw from
      // the factor list — a decision that neither opened nor closed the
      // boundary, just crashed.
      return {
        factor: 'reversibility',
        verdict: 'human_required',
        basis_complete: false,
        reasons: [
          `action.reversibility is ${JSON.stringify(actual)}, which is not one of ` +
            `'reversible', 'compensatable', 'irreversible', 'unknown'; ` +
            `reversibility cannot be judged and the action is not auto-applied`,
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * What would have to be observed to close the basis gap. Freshness contributes
 * the modes of the very items that went stale (re-run those); anything else
 * falls back to the policy's accepted modes.
 *
 * Keyed on `basis_complete`, not on `verdict`: a factor that raised an
 * incomplete signal but routed to `human_required` still needs re-observation.
 */
function requiredEvidenceModes(
  policy: Policy,
  factors: readonly FactorVerdict[],
  freshnessUnresolvedModes: readonly string[],
): string[] {
  const modes = new Set<string>(freshnessUnresolvedModes);

  const otherIncomplete = factors.some(
    (factor) => factor.factor !== 'freshness' && !factor.basis_complete,
  );
  if (otherIncomplete || modes.size === 0) {
    for (const mode of policy.evidence.accepted_modes) modes.add(mode);
  }

  // A set: emitted in canonical order, never in discovery order.
  return sortStrings([...modes]);
}
