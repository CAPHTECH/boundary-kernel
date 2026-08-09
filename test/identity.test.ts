/**
 * Identity binding (design §5): what a decision_id does and does not bind.
 *
 *   decision_id = hash(action_digest, evidence_state_digest,
 *                      policy_id, policy_version)
 *
 * Two components are content hashes; the other two are *labels*. That
 * asymmetry is deliberate — the evidence digest must exclude policy so that
 * attribution can separate causes — but it means the binding to policy is only
 * as strong as the host's discipline about its own version labels. The last
 * test here pins that limitation rather than leaving it to be discovered.
 */

import { notStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attribute } from '../src/attribute.ts';
import { decide } from '../src/decide.ts';
import { actionDigest, evidenceStateDigest } from '../src/digest.ts';
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

  it('decision_id ignores computed_at and kernel_version', async () => {
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
   * KNOWN LIMITATION, pinned deliberately.
   *
   * decision_id binds the policy by *label*, not by content. Two policies
   * sharing (policy_id, version) but differing in substance therefore produce
   * the same decision_id while producing different outcomes — a genuine
   * collision, and one attribute() cannot see either (it reports no_change).
   *
   * The design keeps the label binding on purpose: hashing the policy into the
   * decision would not by itself fix this (the host could still mutate a
   * version in place), and evidence_state_digest must stay policy-free
   * regardless. What closes the hole is a host-side rule — (policy_id,
   * version) is immutable; any change of substance is a version bump — so the
   * discipline is stated in docs/00_design.md §5 and asserted here in the form
   * it actually has, not in the form one might wish it had.
   */
  it('the same policy label over different policy content collides — a documented hole', async () => {
    const request = baseRequest();
    const lenient = basePolicy(); // max_impact: medium
    const strict = basePolicy({ risk: { max_impact: 'none' } }); // same id, same version
    strictEqual(lenient.policy_id, strict.policy_id);
    strictEqual(lenient.version, strict.version);

    const a = await decideFrom(lenient, request);
    const b = await decideFrom(strict, request);

    notStrictEqual(a.outcome, b.outcome); // the boundary really did move
    strictEqual(a.decision_id, b.decision_id); // ...and identity did not notice
    strictEqual(attribute(a, b).cause, 'no_change');
    // The transition is still recorded, which is the one signal a host has
    // that something changed behind an unchanged label.
    strictEqual(attribute(a, b).outcome_transition?.to, b.outcome);
  });
});
