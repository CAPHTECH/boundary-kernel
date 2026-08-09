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
 *   decision_id           = hash(action_digest, evidence_state_digest,
 *                                policy_id, policy_version)
 */

import { canonicalJson } from './canonical.ts';
import type { Action, EvidenceState, Hash, Identifier, Semver } from './types.ts';

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
 * a content hash cannot contain itself.
 */
export async function actionDigest(action: Action): Promise<Hash> {
  const { digest: _self, ...content } = action;
  return digest(content);
}

/**
 * Digest of the evidence state only. Policy is deliberately absent — including
 * it would make "same evidence, different policy" comparisons impossible and
 * therefore break causal attribution (design §5).
 */
export async function evidenceStateDigest(evidenceState: EvidenceState): Promise<Hash> {
  const { digest: _self, ...content } = evidenceState;
  return digest(content);
}

/**
 * The pre-image of `decision_id`. Shared with the synchronous path in
 * `decide.ts` so the two can never drift apart.
 */
export function decisionIdPreimage(input: {
  action_digest: Hash;
  evidence_state_digest: Hash;
  policy_id: Identifier;
  policy_version?: Semver;
}): string {
  return canonicalJson({
    action_digest: input.action_digest,
    evidence_state_digest: input.evidence_state_digest,
    policy_id: input.policy_id,
    policy_version: input.policy_version,
  });
}

/** `decision_id = hash(action_digest, evidence_state_digest, policy_id, policy_version)`. */
export async function decisionId(input: {
  action_digest: Hash;
  evidence_state_digest: Hash;
  policy_id: Identifier;
  policy_version?: Semver;
}): Promise<Hash> {
  const bytes = new TextEncoder().encode(decisionIdPreimage(input));
  return `sha256:${toHex(await subtle().digest('SHA-256', bytes))}`;
}
