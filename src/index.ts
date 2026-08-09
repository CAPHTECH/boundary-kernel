/**
 * Review Boundary Kernel (RBK) — TypeScript reference implementation.
 *
 * One question only: may this action be applied without a human?
 *
 *   const digests = {
 *     action_digest: await actionDigest(request.action),
 *     evidence_state_digest: await evidenceStateDigest(request.evidence_state),
 *   };
 *   const decision = decide(policy, request, digests);
 */

export { decide, compose, composeBasis, KERNEL_VERSION, type DecideOptions } from './decide.ts';
export { attribute } from './attribute.ts';
export {
  digest,
  actionDigest,
  evidenceStateDigest,
  policyDigest,
  policyDigestPreimage,
  decisionId,
  decisionIdPreimage,
  type DecisionIdInput,
} from './digest.ts';
export { canonicalJson, type JsonValue } from './canonical.ts';
export {
  nfcDeep,
  normalizeAction,
  normalizeEvidenceState,
  normalizePolicy,
  sortDimensions,
  sortEvidenceItems,
  sortStalenessReasons,
  sortStrings,
} from './normalize.ts';
export { sha256Bytes, sha256Utf8 } from './sha256.ts';
export * from './types.ts';
