/**
 * Types derived from schemas/rbk.{policy,request,decision}.v1.schema.json.
 *
 * Every union below mirrors the corresponding schema `enum` exactly. If a
 * schema enum changes, this file is the single place that must change with it.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** GAE operational agency vector ⟨O,F,P,J,U,E,L⟩ (design §4). */
export type AgencyDimension =
  | 'observe'
  | 'frame'
  | 'project'
  | 'judge'
  | 'authorize'
  | 'execute'
  | 'learn';

export const AGENCY_DIMENSIONS: readonly AgencyDimension[] = [
  'observe',
  'frame',
  'project',
  'judge',
  'authorize',
  'execute',
  'learn',
];

/**
 * Assurance boundary (測候方法論 §3.4). Ordered weakest → strongest;
 * `evaluator_supported` must never be presented as `formal_verified`.
 */
export type AssuranceLevel =
  | 'runtime_observed'
  | 'evaluator_supported'
  | 'statistically_supported'
  | 'bounded_checked'
  | 'formal_verified';

export const ASSURANCE_ORDER: readonly AssuranceLevel[] = [
  'runtime_observed',
  'evaluator_supported',
  'statistically_supported',
  'bounded_checked',
  'formal_verified',
];

/** reviewgraphen docs/12 §9 staleness taxonomy (12 kinds). */
export type StalenessReason =
  | 'target_changed'
  | 'dependency_changed'
  | 'context_changed'
  | 'evidence_changed'
  | 'test_changed'
  | 'policy_changed'
  | 'rule_changed'
  | 'extractor_changed'
  | 'model_policy_changed'
  | 'decision_expired'
  | 'runtime_evidence_expired'
  | 'mapping_unresolved';

export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_ORDER: readonly Severity[] = ['none', 'low', 'medium', 'high', 'critical'];

/** `^(sha256|blake3):[0-9a-f]{64}$` */
export type Hash = string;

/** `^[a-z0-9][a-z0-9._:-]*$` */
export type Identifier = string;

/** `^[0-9]+\.[0-9]+\.[0-9]+$` */
export type Semver = string;

// ---------------------------------------------------------------------------
// rbk.policy.v1
// ---------------------------------------------------------------------------

export interface PolicyScope {
  action_kinds: string[];
  domains?: string[];
}

export interface PolicyAuthority {
  non_human_may_hold: AgencyDimension[];
  human_reserved?: AgencyDimension[];
  authorize_delegation_rationale?: string;
}

export interface PolicyEvidence {
  required: boolean;
  accepted_modes: string[];
  /** schema default: 1 */
  minimum_count?: number;
  minimum_assurance?: AssuranceLevel;
}

export interface PolicyFreshness {
  require_fresh: boolean;
  max_age_seconds?: number;
  tolerated_staleness_reasons?: StalenessReason[];
}

export interface PolicyRisk {
  max_impact: Severity;
  max_exposure?: number;
  /** Exceeding this yields `incomplete`, not `human_required` (policy schema note). */
  max_uncertainty?: number;
}

export interface PolicyReversibility {
  /** `irreversible` can never be permitted (Rollback Fiction ban). */
  minimum: 'reversible' | 'compensatable';
}

export interface Policy {
  schema: 'rbk.policy.v1';
  policy_id: Identifier;
  version: Semver;
  description?: string;
  scope: PolicyScope;
  authority: PolicyAuthority;
  evidence: PolicyEvidence;
  freshness: PolicyFreshness;
  risk: PolicyRisk;
  reversibility: PolicyReversibility;
}

// ---------------------------------------------------------------------------
// rbk.request.v1
// ---------------------------------------------------------------------------

export type ActorKind = 'human' | 'ai_agent' | 'deterministic' | 'unknown';

export interface ProposedBy {
  actor_id: string;
  actor_kind: ActorKind;
  model?: string;
}

export type ActionReversibility = 'reversible' | 'compensatable' | 'irreversible' | 'unknown';

export interface ActionRisk {
  impact: Severity;
  exposure?: number;
  uncertainty?: number;
  structural_reach?: number;
  rationale?: string;
}

export type ApplicabilityStatus = 'applicable' | 'not_applicable' | 'capability_missing' | 'unknown';

export interface ActionApplicability {
  status: ApplicabilityStatus;
  reasons?: string[];
}

export interface Action {
  action_id: Identifier;
  action_kind: string;
  domain?: string;
  summary?: string;
  proposed_by: ProposedBy;
  requested_dimensions: AgencyDimension[];
  reversibility: ActionReversibility;
  risk: ActionRisk;
  applicability?: ActionApplicability;
  digest?: Hash;
}

export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

export interface EvidenceFreshness {
  status: FreshnessStatus;
  /** `status=stale` with empty reasons is treated as "reason unknown". */
  reasons?: StalenessReason[];
  observed_at?: string;
}

export type EvidenceOutcome = 'passed' | 'failed' | 'inconclusive';

export interface EvidenceItem {
  evidence_id: Identifier;
  mode: string;
  outcome: EvidenceOutcome;
  assurance: AssuranceLevel;
  freshness: EvidenceFreshness;
  produced_by?: string;
}

export interface EvidenceState {
  /** An empty array means "no evidence" — never conflate with omission. */
  items: EvidenceItem[];
  digest?: Hash;
}

export interface HumanAdmission {
  /** `^human:.+` */
  actor: string;
  authority: string;
}

export interface Request {
  schema: 'rbk.request.v1';
  request_id: Identifier;
  action: Action;
  evidence_state: EvidenceState;
  human_admission?: HumanAdmission;
  observed_at?: string;
}

// ---------------------------------------------------------------------------
// rbk.decision.v1
// ---------------------------------------------------------------------------

export type Outcome = 'auto_apply' | 'human_required' | 'incomplete';

export type FactorKind =
  | 'applicability'
  | 'authority'
  | 'evidence'
  | 'freshness'
  | 'risk'
  | 'reversibility';

export const FACTOR_KINDS: readonly FactorKind[] = [
  'applicability',
  'authority',
  'evidence',
  'freshness',
  'risk',
  'reversibility',
];

export type Verdict = 'satisfied' | 'human_required' | 'incomplete';

export interface FactorVerdict {
  factor: FactorKind;
  /** routing axis — where this factor sends the action. */
  verdict: Verdict;
  /**
   * measurement axis (design §3, v0.2) — `false` when this factor raised at
   * least one `incomplete` signal, *including* when `verdict` came out
   * `human_required`. A settled restriction routes, but it must never erase
   * the record that our evidential basis was also short.
   */
  basis_complete: boolean;
  /** Non-`satisfied` verdicts must carry at least one reason (design §4). */
  reasons: string[];
  evidence_ids?: Identifier[];
}

export interface DecisionIdentity {
  action_digest: Hash;
  evidence_state_digest: Hash;
}

export type AttributionCause =
  | 'action_change'
  | 'evidence_change'
  | 'policy_change'
  | 'unattributable'
  | 'no_change';

export type ChangedComponent =
  | 'action_digest'
  | 'evidence_state_digest'
  | 'policy_id'
  | 'policy_version';

export interface OutcomeTransition {
  from: Outcome;
  to: Outcome;
}

export interface Attribution {
  compared_to_decision_id: Hash;
  cause: AttributionCause;
  changed_components?: ChangedComponent[];
  outcome_transition?: OutcomeTransition;
}

export interface Routing {
  /** Mandatory (min 1 entry) whenever outcome is `incomplete`. */
  required_evidence_modes?: string[];
  escalate_to?: string;
}

export interface Decision {
  schema: 'rbk.decision.v2';
  decision_id: Hash;
  request_id: Identifier;
  policy_id: Identifier;
  policy_version?: Semver;
  /** routing axis (design §3). */
  outcome: Outcome;
  /**
   * measurement axis (design §3, v0.2): `false` iff any factor raised an
   * `incomplete` signal. `outcome === 'incomplete'` is exactly the case
   * `basis_complete === false` with no `human_required` factor.
   */
  basis_complete: boolean;
  granted_dimensions?: AgencyDimension[];
  withheld_dimensions?: AgencyDimension[];
  factors: FactorVerdict[];
  identity: DecisionIdentity;
  attribution?: Attribution;
  routing?: Routing;
  computed_at: string;
  kernel_version?: Semver;
}

/** Digests supplied to `decide()` — the kernel never hashes anything itself. */
export interface RequestDigests {
  action_digest: Hash;
  evidence_state_digest: Hash;
}
