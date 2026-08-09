/**
 * Causal attribution between two decisions (design §5).
 *
 * The identity split — `evidence_state_digest` deliberately excludes policy —
 * is what makes this mechanical:
 *
 *     action_digest changed only         → action_change
 *     evidence_state_digest changed only → evidence_change
 *     policy_digest / _id / _version only → policy_change
 *     more than one of the above         → unattributable
 *
 * `policy_digest` is what makes a policy change visible even when the host
 * left `(policy_id, version)` untouched: the label can lie, the content hash
 * cannot.
 *
 * `unattributable` is stated, never guessed at. Presenting a multi-component
 * change as a single cause is exactly the failure this discipline forbids —
 * in particular, a policy change must never be attributed to evidence.
 */

import type { Attribution, ChangedComponent, Decision } from './types.ts';

export function attribute(prev: Decision, next: Decision): Attribution {
  const changed_components: ChangedComponent[] = [];

  if (prev.identity.action_digest !== next.identity.action_digest) {
    changed_components.push('action_digest');
  }
  if (prev.identity.evidence_state_digest !== next.identity.evidence_state_digest) {
    changed_components.push('evidence_state_digest');
  }
  if (prev.identity.policy_digest !== next.identity.policy_digest) {
    changed_components.push('policy_digest');
  }
  if (prev.policy_id !== next.policy_id) {
    changed_components.push('policy_id');
  }
  if (prev.policy_version !== next.policy_version) {
    changed_components.push('policy_version');
  }

  // policy_digest, policy_id and policy_version are three components of one
  // thing; changing several of them is still a single policy change.
  const causes = new Set<'action_change' | 'evidence_change' | 'policy_change'>();
  for (const component of changed_components) {
    switch (component) {
      case 'action_digest':
        causes.add('action_change');
        break;
      case 'evidence_state_digest':
        causes.add('evidence_change');
        break;
      case 'policy_digest':
      case 'policy_id':
      case 'policy_version':
        causes.add('policy_change');
        break;
    }
  }

  const cause: Attribution['cause'] =
    causes.size === 0
      ? 'no_change'
      : causes.size === 1
        ? [...causes][0]!
        : 'unattributable';

  const attribution: Attribution = {
    compared_to_decision_id: prev.decision_id,
    cause,
    changed_components,
  };

  if (prev.outcome !== next.outcome) {
    attribution.outcome_transition = { from: prev.outcome, to: next.outcome };
  }

  return attribution;
}
