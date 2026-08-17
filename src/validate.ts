/**
 * Runtime validation of `decide()`'s inputs (design §4).
 *
 * The schemas have always declared the domains — `rbk.request.v1` gives
 * `severity` as an enum, `rbk.policy.v1` gives the reversibility floor as one —
 * but `decide()` took `Policy` and `Request` as TypeScript types only, and a
 * type is not a check. A host passing unvalidated JSON reached the comparisons
 * directly, and the comparisons are written in terms of ordinal rank:
 *
 *   severityRank = (level) => SEVERITY_ORDER.indexOf(level)   // -1 when unknown
 *   if (severityRank(risk.impact) > severityRank(policy.risk.max_impact))
 *
 * `-1 > 3` is false, so an `impact` outside the enum raised no verdict and no
 * reason, the factor resolved to `satisfied`, and the decision composed to
 * `auto_apply` with `basis_complete: true`. A difference of letter case was
 * enough. Eight fields behaved this way; see the module's tests.
 *
 * **The direction matters more than the count.** This kernel exists to decide
 * whether an action may be applied *without a human*. An input it cannot read
 * is not an input it may wave through: the correct response to "I could not
 * evaluate this" is to route it to a person, never to open the boundary. So a
 * value outside its declared domain now yields
 *
 *   verdict:        human_required   — routing: a person must look at this
 *   basis_complete: false            — measurement: our basis was short
 *   reasons:        non-empty        — naming field, value and expected domain
 *
 * on the factor that would have consumed it. Both axes are stated because both
 * are true, which is exactly the independence design §3 established in v0.2.
 *
 * Note this is deliberately *not* `incomplete`. `incomplete` is the kernel's
 * "the boundary cannot be computed yet" and its remedy is further observation —
 * `evaluateRisk` uses it for `max_uncertainty` for that reason. A malformed
 * enum is not a measurement that came out short; it is not a measurement at
 * all, and no amount of re-observation fixes it. Routing it to `incomplete`
 * would tell an automated host to gather more evidence and resubmit, and a host
 * that deterministically emits `"CRITICAL"` would loop there forever without
 * ever reaching the person who could fix it.
 *
 * Two classes of defect, split by whether a decision can be built at all:
 *
 *   shape   — the input cannot be normalized or digested (`items` is not an
 *             array, `action` is not an object). `policy_digest` is part of a
 *             decision's identity and cannot be computed, so there is no
 *             `rbk.decision.v3` to return. These throw.
 *   domain  — the input canonicalizes fine but a value sits outside its
 *             declared set. These become the `human_required` factors above.
 *
 * The domains come from the `readonly` arrays in `types.ts` rather than being
 * restated here, so that adding a member to an enum cannot leave validation
 * behind. That file already declares itself the single place a schema enum
 * change has to land; this module depends on that and does not duplicate it.
 */

import {
  ACTION_REVERSIBILITIES,
  ACTOR_KINDS,
  AGENCY_DIMENSIONS,
  APPLICABILITY_STATUSES,
  ASSURANCE_ORDER,
  EVIDENCE_OUTCOMES,
  FRESHNESS_STATUSES,
  REVERSIBILITY_FLOORS,
  SEVERITY_ORDER,
  STALENESS_REASONS,
  type FactorKind,
  type Policy,
  type Request,
} from './types.ts';

/**
 * The input could not be read well enough to produce any decision at all.
 * Thrown rather than returned: a decision without `identity.policy_digest` is
 * not a decision this kernel is allowed to emit.
 */
export class RbkInvalidInputError extends Error {
  readonly defects: readonly string[];

  constructor(defects: readonly string[]) {
    super(
      `decide() received input it cannot read: ${defects.join('; ')}. ` +
        `No decision was produced — a malformed input must not be reported as a boundary.`,
    );
    this.name = 'RbkInvalidInputError';
    this.defects = [...defects];
  }
}

/** A value outside its declared domain, attributed to the factor that reads it. */
export interface InputDefect {
  factor: FactorKind;
  reason: string;
}

// ---------------------------------------------------------------------------
// Predicates and rendering
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * How an offending value is shown in a reason. The *type* is named alongside
 * the value because `9` and `"9"` are different defects with the same
 * appearance, and a reader fixing the host needs to know which one arrived.
 */
function describe(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value}' (string)`;
  if (typeof value === 'number') return `${value} (number)`;
  if (typeof value === 'boolean') return `${value} (boolean)`;
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

const outsideDomain = (path: string, value: unknown, domain: readonly string[]): string =>
  `${path} is ${describe(value)}, which is not one of the declared values ` +
  `(${domain.join(', ')}); the boundary cannot be computed from it`;

const notANumber = (path: string, value: unknown): string =>
  `${path} is ${describe(value)}, which is not a finite number; ` +
  `the comparison against the policy ceiling cannot be computed from it`;

const notABoolean = (path: string, value: unknown): string =>
  `${path} is ${describe(value)}, which is not a boolean; ` +
  `whether the rule applies cannot be determined from it`;

const notAString = (path: string, value: unknown): string =>
  `${path} is ${describe(value)}, which is not a string`;

// ---------------------------------------------------------------------------
// Shape — can a decision be built at all?
// ---------------------------------------------------------------------------

/**
 * Checks only what `normalize.ts` and `digest.ts` must be able to walk. Anything
 * finer is a domain question and is answered without throwing.
 */
function shapeDefects(policy: unknown, request: unknown): string[] {
  const defects: string[] = [];

  const object = (value: unknown, path: string): value is Record<string, unknown> => {
    if (isObject(value)) return true;
    defects.push(`${path} is ${describe(value)}, which is not an object`);
    return false;
  };
  const array = (value: unknown, path: string): value is unknown[] => {
    if (Array.isArray(value)) return true;
    defects.push(`${path} is ${describe(value)}, which is not an array`);
    return false;
  };
  const optionalArray = (value: unknown, path: string): void => {
    if (value !== undefined) array(value, path);
  };

  if (object(policy, 'policy')) {
    if (object(policy.scope, 'policy.scope')) {
      array(policy.scope.action_kinds, 'policy.scope.action_kinds');
      optionalArray(policy.scope.domains, 'policy.scope.domains');
    }
    if (object(policy.authority, 'policy.authority')) {
      array(policy.authority.non_human_may_hold, 'policy.authority.non_human_may_hold');
      optionalArray(policy.authority.human_reserved, 'policy.authority.human_reserved');
    }
    if (object(policy.evidence, 'policy.evidence')) {
      array(policy.evidence.accepted_modes, 'policy.evidence.accepted_modes');
    }
    if (object(policy.freshness, 'policy.freshness')) {
      optionalArray(
        policy.freshness.tolerated_staleness_reasons,
        'policy.freshness.tolerated_staleness_reasons',
      );
    }
    object(policy.risk, 'policy.risk');
    object(policy.reversibility, 'policy.reversibility');
  }

  if (object(request, 'request')) {
    if (object(request.action, 'request.action')) {
      const action = request.action;
      object(action.proposed_by, 'request.action.proposed_by');
      object(action.risk, 'request.action.risk');
      array(action.requested_dimensions, 'request.action.requested_dimensions');
      if (action.applicability !== undefined) {
        if (object(action.applicability, 'request.action.applicability')) {
          optionalArray(
            action.applicability.reasons,
            'request.action.applicability.reasons',
          );
        }
      }
    }
    if (object(request.evidence_state, 'request.evidence_state')) {
      const items = request.evidence_state.items;
      if (array(items, 'request.evidence_state.items')) {
        items.forEach((item, index) => {
          const path = `request.evidence_state.items[${index}]`;
          if (!object(item, path)) return;
          if (object(item.freshness, `${path}.freshness`)) {
            optionalArray(item.freshness.reasons, `${path}.freshness.reasons`);
          }
        });
      }
    }
  }

  return defects;
}

// ---------------------------------------------------------------------------
// Domain — is every value inside the set its schema declares?
// ---------------------------------------------------------------------------

function domainDefects(policy: Policy, request: Request): InputDefect[] {
  const defects: InputDefect[] = [];
  const p = policy as unknown as Record<string, any>;
  const r = request as unknown as Record<string, any>;

  const add = (factor: FactorKind, reason: string | undefined): void => {
    if (reason !== undefined) defects.push({ factor, reason });
  };

  /** Present and inside the domain, or a defect. */
  const member = (path: string, value: unknown, domain: readonly string[]): string | undefined =>
    typeof value === 'string' && domain.includes(value)
      ? undefined
      : outsideDomain(path, value, domain);

  /** Absent is allowed; anything present must be inside the domain. */
  const optionalMember = (
    path: string,
    value: unknown,
    domain: readonly string[],
  ): string | undefined => (value === undefined ? undefined : member(path, value, domain));

  const number = (path: string, value: unknown): string | undefined =>
    isFiniteNumber(value) ? undefined : notANumber(path, value);
  const optionalNumber = (path: string, value: unknown): string | undefined =>
    value === undefined ? undefined : number(path, value);
  const boolean = (path: string, value: unknown): string | undefined =>
    typeof value === 'boolean' ? undefined : notABoolean(path, value);
  const string = (path: string, value: unknown): string | undefined =>
    typeof value === 'string' ? undefined : notAString(path, value);
  const optionalString = (path: string, value: unknown): string | undefined =>
    value === undefined ? undefined : string(path, value);

  const members = (
    factor: FactorKind,
    path: string,
    values: unknown,
    domain: readonly string[],
  ): void => {
    if (!Array.isArray(values)) return; // a shape defect; already reported
    values.forEach((value, index) => add(factor, member(`${path}[${index}]`, value, domain)));
  };
  const strings = (factor: FactorKind, path: string, values: unknown): void => {
    if (!Array.isArray(values)) return;
    values.forEach((value, index) => add(factor, string(`${path}[${index}]`, value)));
  };

  // --- applicability ------------------------------------------------------
  strings('applicability', 'policy.scope.action_kinds', p.scope?.action_kinds);
  if (p.scope?.domains !== undefined) {
    strings('applicability', 'policy.scope.domains', p.scope.domains);
  }
  add('applicability', string('request.action.action_kind', r.action?.action_kind));
  add('applicability', optionalString('request.action.domain', r.action?.domain));
  if (r.action?.applicability !== undefined) {
    add(
      'applicability',
      member(
        'request.action.applicability.status',
        r.action.applicability.status,
        APPLICABILITY_STATUSES,
      ),
    );
    if (r.action.applicability.reasons !== undefined) {
      strings('applicability', 'request.action.applicability.reasons', r.action.applicability.reasons);
    }
  }

  // --- authority ----------------------------------------------------------
  members(
    'authority',
    'policy.authority.non_human_may_hold',
    p.authority?.non_human_may_hold,
    AGENCY_DIMENSIONS,
  );
  if (p.authority?.human_reserved !== undefined) {
    members('authority', 'policy.authority.human_reserved', p.authority.human_reserved, AGENCY_DIMENSIONS);
  }
  add(
    'authority',
    optionalString(
      'policy.authority.authorize_delegation_rationale',
      p.authority?.authorize_delegation_rationale,
    ),
  );
  add(
    'authority',
    member('request.action.proposed_by.actor_kind', r.action?.proposed_by?.actor_kind, ACTOR_KINDS),
  );
  members(
    'authority',
    'request.action.requested_dimensions',
    r.action?.requested_dimensions,
    AGENCY_DIMENSIONS,
  );

  // --- evidence and freshness --------------------------------------------
  // The evidence items feed `qualifyingEvidence`, which is the shared input of
  // *both* factors. An unreadable item therefore blocks both: `freshness` judges
  // exactly the items `evidence` qualified, so it cannot be sound while the
  // qualification is not.
  add('evidence', boolean('policy.evidence.required', p.evidence?.required));
  strings('evidence', 'policy.evidence.accepted_modes', p.evidence?.accepted_modes);
  add('evidence', optionalNumber('policy.evidence.minimum_count', p.evidence?.minimum_count));
  add(
    'evidence',
    optionalMember('policy.evidence.minimum_assurance', p.evidence?.minimum_assurance, ASSURANCE_ORDER),
  );

  add('freshness', boolean('policy.freshness.require_fresh', p.freshness?.require_fresh));
  add('freshness', optionalNumber('policy.freshness.max_age_seconds', p.freshness?.max_age_seconds));
  if (p.freshness?.tolerated_staleness_reasons !== undefined) {
    members(
      'freshness',
      'policy.freshness.tolerated_staleness_reasons',
      p.freshness.tolerated_staleness_reasons,
      STALENESS_REASONS,
    );
  }
  add('freshness', optionalString('request.observed_at', r.observed_at));

  const items = r.evidence_state?.items;
  if (Array.isArray(items)) {
    items.forEach((item: any, index: number) => {
      const path = `request.evidence_state.items[${index}]`;
      // Reported against both factors, for the reason given above.
      const both = (reason: string | undefined): void => {
        add('evidence', reason);
        add('freshness', reason);
      };
      both(string(`${path}.evidence_id`, item?.evidence_id));
      both(string(`${path}.mode`, item?.mode));
      both(member(`${path}.outcome`, item?.outcome, EVIDENCE_OUTCOMES));
      both(member(`${path}.assurance`, item?.assurance, ASSURANCE_ORDER));
      both(member(`${path}.freshness.status`, item?.freshness?.status, FRESHNESS_STATUSES));
      both(optionalString(`${path}.freshness.observed_at`, item?.freshness?.observed_at));
      if (item?.freshness?.reasons !== undefined && Array.isArray(item.freshness.reasons)) {
        item.freshness.reasons.forEach((reason: unknown, reasonIndex: number) => {
          both(member(`${path}.freshness.reasons[${reasonIndex}]`, reason, STALENESS_REASONS));
        });
      }
    });
  }

  // --- risk ---------------------------------------------------------------
  add('risk', member('policy.risk.max_impact', p.risk?.max_impact, SEVERITY_ORDER));
  add('risk', optionalNumber('policy.risk.max_exposure', p.risk?.max_exposure));
  add('risk', optionalNumber('policy.risk.max_uncertainty', p.risk?.max_uncertainty));
  add('risk', member('request.action.risk.impact', r.action?.risk?.impact, SEVERITY_ORDER));
  add('risk', optionalNumber('request.action.risk.exposure', r.action?.risk?.exposure));
  add('risk', optionalNumber('request.action.risk.uncertainty', r.action?.risk?.uncertainty));

  // --- reversibility ------------------------------------------------------
  add(
    'reversibility',
    member('policy.reversibility.minimum', p.reversibility?.minimum, REVERSIBILITY_FLOORS),
  );
  add(
    'reversibility',
    member('request.action.reversibility', r.action?.reversibility, ACTION_REVERSIBILITIES),
  );

  return defects;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validates the pair `decide()` was given.
 *
 * Throws `RbkInvalidInputError` when the input cannot be normalized or digested
 * at all; otherwise returns every value found outside its declared domain,
 * attributed to the factor that reads it. An empty array means the kernel can
 * evaluate every field it is about to branch on.
 *
 * Exported so a host can run the same check ahead of `decide()` and reject at
 * its own edge instead of receiving a `human_required` it then has to route.
 */
export function validateInputs(policy: Policy, request: Request): InputDefect[] {
  const shape = shapeDefects(policy, request);
  if (shape.length > 0) throw new RbkInvalidInputError(shape);
  return domainDefects(policy, request);
}
