/**
 * Content digests over canonical JSON.
 *
 * Uses Web Crypto (`crypto.subtle`), which is present on both Node 22+ and
 * Cloudflare Workers as a global — hence the async surface. `decide()` never
 * calls into here: it receives digests as arguments so that it stays a
 * synchronous pure function (design §5 identity is an input to the boundary
 * computation, not a side effect of it).
 *
 * The separation that matters (design §5):
 *   evidence_state_digest = hash(evidence state only)   ← never includes policy
 *   policy_digest         = hash(policy content)
 *   decision_id           = hash(action_digest, evidence_state_digest,
 *                                policy_digest, policy_id, policy_version,
 *                                decision_schema, kernel_version)
 *
 * The two are not in tension: the evidence digest stays policy-free so that
 * attribution can separate an evidence change from a policy change, while the
 * decision's own identity binds the policy by content and not merely by the
 * host's label.
 */

import { canonicalJson } from './canonical.ts';
import { normalizeAction, normalizeEvidenceState, normalizePolicy } from './normalize.ts';
import type { Action, EvidenceState, Hash, Identifier, Policy, Semver } from './types.ts';

const subtle = (): SubtleCrypto => {
  const c: Crypto | undefined = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('digest: Web Crypto (crypto.subtle) is not available in this runtime');
  }
  return c.subtle;
};

function toHex(buffer: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 of the canonical JSON of `value`, prefixed `sha256:`. */
export async function digest(value: unknown): Promise<Hash> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hashed = await subtle().digest('SHA-256', bytes);
  return `sha256:${toHex(hashed)}`;
}

/**
 * Digest of the action's content. The action's own `digest` field is excluded:
 * a content hash cannot contain itself. Set-typed members are normalized first
 * (`normalize.ts`) so that reordering a set is not mistaken for a change.
 */
export async function actionDigest(action: Action): Promise<Hash> {
  const { digest: _self, ...content } = normalizeAction(action);
  return digest(content);
}

/**
 * Digest of the evidence state only. Policy is deliberately absent — including
 * it would make "same evidence, different policy" comparisons impossible and
 * therefore break causal attribution (design §5).
 */
export async function evidenceStateDigest(evidenceState: EvidenceState): Promise<Hash> {
  const { digest: _self, ...content } = normalizeEvidenceState(evidenceState);
  return digest(content);
}

/**
 * The pre-image of `policy_digest`, shared with the synchronous path in
 * `decide.ts` (which computes the policy digest itself rather than accepting
 * one, so that no host can hand the kernel a digest of a policy other than the
 * one it was asked to apply).
 */
export function policyDigestPreimage(policy: Policy): string {
  return canonicalJson(normalizePolicy(policy));
}

/**
 * Digest of the policy's content. Unlike `policy_id` and `version` — which are
 * labels the host controls — this moves whenever the policy's substance moves,
 * including when the substance is changed behind an unchanged label.
 */
export async function policyDigest(policy: Policy): Promise<Hash> {
  const bytes = new TextEncoder().encode(policyDigestPreimage(policy));
  return `sha256:${toHex(await subtle().digest('SHA-256', bytes))}`;
}

export interface DecisionIdInput {
  action_digest: Hash;
  evidence_state_digest: Hash;
  policy_digest: Hash;
  policy_id: Identifier;
  policy_version?: Semver;
  /** The decision schema the identity belongs to, e.g. `rbk.decision.v2`. */
  decision_schema: string;
  /** The kernel that computed the decision, not a label the host chose. */
  kernel_version: Semver;
}

/**
 * The pre-image of `decision_id`. Shared with the synchronous path in
 * `decide.ts` so the two can never drift apart.
 *
 * `decision_schema` and `kernel_version` are in the pre-image because the
 * identity names a computation, not just its inputs: a v1 and a v2 decision
 * over identical inputs mean different things, and two kernel versions may
 * compute different boundaries from the same request. Without them the two
 * would collide under one id.
 */
export function decisionIdPreimage(input: DecisionIdInput): string {
  return canonicalJson({
    action_digest: input.action_digest,
    decision_schema: input.decision_schema,
    evidence_state_digest: input.evidence_state_digest,
    kernel_version: input.kernel_version,
    policy_digest: input.policy_digest,
    policy_id: input.policy_id,
    policy_version: input.policy_version,
  });
}

/**
 * `decision_id = hash(action_digest, decision_schema, evidence_state_digest,
 * kernel_version, policy_digest, policy_id, policy_version)`.
 */
export async function decisionId(input: DecisionIdInput): Promise<Hash> {
  const bytes = new TextEncoder().encode(decisionIdPreimage(input));
  return `sha256:${toHex(await subtle().digest('SHA-256', bytes))}`;
}
