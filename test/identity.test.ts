/**
 * Identity binding (design §5): what a decision_id binds.
 *
 *   decision_id = hash(action_digest, evidence_state_digest,
 *                      policy_digest, policy_id, policy_version,
 *                      decision_schema, kernel_version)
 *
 * Up to v0.2 the policy was bound by *label* only (`policy_id`, `version`), on
 * the stated grounds that a content hash would not help because a host could
 * rewrite a policy behind an unchanged version. That reasoning was wrong: a
 * content hash moves with the content precisely regardless of the label, so it
 * detects exactly that rewrite. `policy_digest` closes the hole, and the last
 * two tests here assert it closed rather than pinning its shape.
 */

import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attribute } from '../src/attribute.ts';
import { decide } from '../src/decide.ts';
import { actionDigest, evidenceStateDigest, policyDigest } from '../src/digest.ts';
import type { Policy, Request, RequestDigests } from '../src/types.ts';
import { AT, baseRequest, basePolicy, passingEvidence } from './builders.ts';

async function digestsFor(request: Request): Promise<RequestDigests> {
  return {
    action_digest: await actionDigest(request.action),
    evidence_state_digest: await evidenceStateDigest(request.evidence_state),
  };
}

async function decideFrom(policy: Policy, request: Request) {
  return decide(policy, request, await digestsFor(request), { computed_at: AT });
}

describe('identity binding', () => {
  it('different action content gives a different decision_id', async () => {
    const a = await decideFrom(basePolicy(), baseRequest());
    const b = await decideFrom(
      basePolicy(),
      baseRequest({ action: { summary: 'a materially different patch' } }),
    );
    notStrictEqual(a.decision_id, b.decision_id);
    notStrictEqual(a.identity.action_digest, b.identity.action_digest);
    strictEqual(a.identity.evidence_state_digest, b.identity.evidence_state_digest);
    strictEqual(attribute(a, b).cause, 'action_change');
  });

  it('different evidence content gives a different decision_id', async () => {
    const a = await decideFrom(basePolicy(), baseRequest());
    const b = await decideFrom(
      basePolicy(),
      baseRequest({ evidence_state: { items: [passingEvidence({ produced_by: 'other-runner' })] } }),
    );
    notStrictEqual(a.decision_id, b.decision_id);
    strictEqual(attribute(a, b).cause, 'evidence_change');
  });

  it('a different policy_id over identical inputs gives a different decision_id', async () => {
    const request = baseRequest();
    const a = await decideFrom(basePolicy(), request);
    const b = await decideFrom(basePolicy({ policy_id: 'other-policy' }), request);
    notStrictEqual(a.decision_id, b.decision_id);
    strictEqual(a.identity.evidence_state_digest, b.identity.evidence_state_digest);
  });

  it('a version bump alone gives a different decision_id', async () => {
    const request = baseRequest();
    const a = await decideFrom(basePolicy(), request);
    const b = await decideFrom(basePolicy({ version: '1.0.1' }), request);
    notStrictEqual(a.decision_id, b.decision_id);
  });

  it('the declared digest field is not part of the content it claims to digest', async () => {
    const request = baseRequest();
    const honest = await actionDigest(request.action);
    const lying = await actionDigest({ ...request.action, digest: `sha256:${'f'.repeat(64)}` });
    // A content hash cannot contain itself, so a wrong (or absent) declared
    // digest cannot change the computed one.
    strictEqual(honest, lying);
  });

  /**
   * `computed_at` is wall clock, and `options.kernel_version` is only a label
   * written into the emitted field. The identity binds `KERNEL_VERSION` — the
   * kernel that actually ran — so that one computation cannot be given many
   * ids by a host relabelling it.
   */
  it('decision_id ignores computed_at and the declared kernel_version label', async () => {
    const request = baseRequest();
    const digests = await digestsFor(request);
    const a = decide(basePolicy(), request, digests, { computed_at: AT, kernel_version: '0.2.0' });
    const b = decide(basePolicy(), request, digests, {
      computed_at: '2031-01-01T00:00:00Z',
      kernel_version: '9.9.9',
    });
    strictEqual(a.decision_id, b.decision_id);
  });

  /**
   * The hole that v0.2 declared unclosable, closed.
   *
   * A policy rewritten in place — same policy_id, same version, different
   * substance — used to yield the same decision_id while yielding a different
   * outcome, and attribute() reported no_change. The content hash sees it,
   * because a content hash is a function of the content and not of the label
   * the host chose to leave alone.
   */
  it('the same policy label over different policy content no longer collides', async () => {
    const request = baseRequest();
    const lenient = basePolicy(); // max_impact: medium
    const strict = basePolicy({ risk: { max_impact: 'none' } }); // same id, same version
    strictEqual(lenient.policy_id, strict.policy_id);
    strictEqual(lenient.version, strict.version);

    const a = await decideFrom(lenient, request);
    const b = await decideFrom(strict, request);

    notStrictEqual(a.outcome, b.outcome); // the boundary really did move
    notStrictEqual(a.identity.policy_digest, b.identity.policy_digest); // ...and identity saw it
    notStrictEqual(a.decision_id, b.decision_id);

    const result = attribute(a, b);
    strictEqual(result.cause, 'policy_change'); // no longer 'no_change'
    deepStrictEqual(result.changed_components, ['policy_digest']);
    strictEqual(result.outcome_transition?.to, b.outcome);

    // The separation the design does keep: the evidence digest stays
    // policy-free, so a policy change is never attributable to the evidence.
    strictEqual(a.identity.evidence_state_digest, b.identity.evidence_state_digest);
    strictEqual(a.identity.action_digest, b.identity.action_digest);
  });

  it('the policy digest is the kernel’s own, not a value the host can supply', async () => {
    const policy = basePolicy();
    const decision = await decideFrom(policy, baseRequest());
    strictEqual(decision.identity.policy_digest, await policyDigest(policy));
    // Reordering a set inside the policy is not a change of policy.
    const permuted = basePolicy({
      authority: {
        non_human_may_hold: ['execute', 'judge', 'project', 'frame', 'observe'],
        human_reserved: ['learn', 'authorize'],
      },
    });
    strictEqual(await policyDigest(permuted), await policyDigest(policy));
    // Changing its substance is.
    notStrictEqual(
      await policyDigest(basePolicy({ risk: { max_impact: 'none' } })),
      await policyDigest(policy),
    );
  });
});
