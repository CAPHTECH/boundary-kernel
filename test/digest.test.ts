import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attribute } from '../src/attribute.ts';
import { canonicalJson } from '../src/canonical.ts';
import { actionDigest, decisionId, decisionIdPreimage, digest, evidenceStateDigest } from '../src/digest.ts';
import { nfcDeep, normalizeAction, normalizeEvidenceState } from '../src/normalize.ts';
import { sha256Utf8 } from '../src/sha256.ts';
import { decide } from '../src/decide.ts';
import type { EvidenceItem, RequestDigests } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS, passingEvidence } from './builders.ts';
import { FIXTURE_NAMES, loadFixture } from './helpers.ts';

describe('canonical JSON', () => {
  it('sorts object keys recursively', () => {
    strictEqual(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order — to the serializer every array is a sequence', () => {
    // Set semantics live in normalize.ts, deliberately not here.
    notStrictEqual(canonicalJson({ x: [1, 2] }), canonicalJson({ x: [2, 1] }));
  });

  it('does not normalize Unicode — that decision belongs to normalize.ts', () => {
    const composed = 'caf\u00e9'; // NFC: e-acute as a single code point
    const decomposed = 'cafe\u0301'; // NFD: e + combining acute
    notStrictEqual(canonicalJson({ x: composed }), canonicalJson({ x: decomposed }));
    strictEqual(canonicalJson({ x: nfcDeep(decomposed) }), canonicalJson({ x: composed }));
  });

  it('drops undefined members rather than emitting null', () => {
    strictEqual(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it('rejects values a digest could silently lose', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let threw = false;
      try {
        canonicalJson({ x: bad });
      } catch {
        threw = true;
      }
      strictEqual(threw, true);
    }
  });
});

describe('digest determinism', () => {
  it('the same meaning with different key order gives the same digest', async () => {
    const a = {
      action_kind: 'code.patch',
      risk: { impact: 'low', exposure: 0.1 },
      dimensions: ['project', 'execute'],
    };
    const b = {
      dimensions: ['project', 'execute'],
      risk: { exposure: 0.1, impact: 'low' },
      action_kind: 'code.patch',
    };
    strictEqual(await digest(a), await digest(b));
  });

  it('different content gives a different digest', async () => {
    notStrictEqual(await digest({ a: 1 }), await digest({ a: 2 }));
  });

  it('array order changes the digest', async () => {
    notStrictEqual(await digest({ d: ['project', 'execute'] }), await digest({ d: ['execute', 'project'] }));
  });

  it('produces the sha256:<64 hex> shape the schemas require', async () => {
    strictEqual(/^sha256:[0-9a-f]{64}$/.test(await digest({})), true);
  });

  it('matches a known SHA-256 vector', async () => {
    // sha256("") — anchors both implementations to the real algorithm.
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    strictEqual(sha256Utf8(''), empty);
    strictEqual(sha256Utf8('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('the synchronous SHA-256 agrees with Web Crypto', async () => {
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ありがとう', '🙂🙃'];
    for (const sample of samples) {
      strictEqual(`sha256:${sha256Utf8(sample)}`, await digestOfRawString(sample));
    }
  });

  it('agrees with Web Crypto on every fixture request', async () => {
    for (const name of FIXTURE_NAMES) {
      const fixture = loadFixture(name);
      // The pre-image is the *normalized* value: sets in canonical order, NFC.
      strictEqual(
        `sha256:${sha256Utf8(canonicalJson(withoutDigest(normalizeAction(fixture.request.action))))}`,
        await actionDigest(fixture.request.action),
      );
      strictEqual(
        `sha256:${sha256Utf8(
          canonicalJson(withoutDigest(normalizeEvidenceState(fixture.request.evidence_state))),
        )}`,
        await evidenceStateDigest(fixture.request.evidence_state),
      );
    }
  });

  it('every fixture request already carries the digest it claims', async () => {
    for (const name of FIXTURE_NAMES) {
      const fixture = loadFixture(name);
      const declared = {
        action: fixture.request.action.digest,
        evidence: fixture.request.evidence_state.digest,
      };
      const computed = {
        action: await actionDigest(fixture.request.action),
        evidence: await evidenceStateDigest(fixture.request.evidence_state),
      };
      // 01–04 predate this check and carry placeholders (README: digest 類は
      // ダミー値); 05 was generated from its own content. Only the latter is
      // asserted, and it is asserted exactly.
      if (name === '05-human-required-with-incomplete-basis') {
        strictEqual(declared.action, computed.action);
        strictEqual(declared.evidence, computed.evidence);
      }
    }
  });
});

/**
 * Design §5: `requested_dimensions` and `evidence_state.items` are sets. A
 * permutation carries no information, so it must not move a digest — the v0.1
 * canonicalizer let it, which made `attribute()` report a phantom
 * `evidence_change` for a request that had not changed at all.
 */
describe('set-typed arrays are order-independent', () => {
  it('reordering requested_dimensions does not move the action digest', async () => {
    const forward = baseRequest({ action: { requested_dimensions: ['project', 'execute'] } });
    const reversed = baseRequest({ action: { requested_dimensions: ['execute', 'project'] } });
    strictEqual(await actionDigest(forward.action), await actionDigest(reversed.action));
  });

  it('reordering evidence items does not move the evidence digest', async () => {
    const a = passingEvidence({ evidence_id: 'ev-a' });
    const b = passingEvidence({ evidence_id: 'ev-b', mode: 'static_verification' });
    strictEqual(
      await evidenceStateDigest({ items: [a, b] }),
      await evidenceStateDigest({ items: [b, a] }),
    );
  });

  it('reordering staleness reasons does not move the evidence digest', async () => {
    const withReasons = (reasons: NonNullable<EvidenceItem['freshness']['reasons']>): EvidenceItem =>
      passingEvidence({ freshness: { status: 'stale', reasons } });
    strictEqual(
      await evidenceStateDigest({ items: [withReasons(['target_changed', 'test_changed'])] }),
      await evidenceStateDigest({ items: [withReasons(['test_changed', 'target_changed'])] }),
    );
  });

  it('a permutation is no_change, not evidence_change', async () => {
    const digestsFor = async (items: EvidenceItem[]): Promise<RequestDigests> => ({
      action_digest: await actionDigest(baseRequest().action),
      evidence_state_digest: await evidenceStateDigest({ items }),
    });
    const a = passingEvidence({ evidence_id: 'ev-a' });
    const b = passingEvidence({ evidence_id: 'ev-b' });

    const before = decide(basePolicy(), baseRequest({ evidence_state: { items: [a, b] } }), await digestsFor([a, b]), { computed_at: AT });
    const after = decide(basePolicy(), baseRequest({ evidence_state: { items: [b, a] } }), await digestsFor([b, a]), { computed_at: AT });

    strictEqual(attribute(before, after).cause, 'no_change');
    strictEqual(before.decision_id, after.decision_id);
    deepStrictEqual(after.factors, before.factors);
  });

  it('a genuine change still moves the digest', async () => {
    const a = passingEvidence({ evidence_id: 'ev-a' });
    const b = passingEvidence({ evidence_id: 'ev-b' });
    notStrictEqual(
      await evidenceStateDigest({ items: [a, b] }),
      await evidenceStateDigest({ items: [a, { ...b, outcome: 'failed' }] }),
    );
  });

  it('sequence-typed arrays keep their order — reasons are narrative', async () => {
    const withReasons = (reasons: string[]) =>
      baseRequest({ action: { applicability: { status: 'capability_missing', reasons } } }).action;
    notStrictEqual(
      await actionDigest(withReasons(['analyser absent', 'sandbox unavailable'])),
      await actionDigest(withReasons(['sandbox unavailable', 'analyser absent'])),
    );
  });
});

describe('Unicode normalization at the digest boundary', () => {
  const NFC = 'caf\u00e9'; // e-acute as a single code point
  const NFD = 'cafe\u0301'; // e + combining acute

  it('NFC and NFD spellings of the same summary give the same digest', async () => {
    const composed = baseRequest({ action: { summary: `${NFC} rollout` } }).action;
    const decomposed = baseRequest({ action: { summary: `${NFD} rollout` } }).action;
    notStrictEqual(composed.summary, decomposed.summary); // genuinely different code points
    strictEqual(await actionDigest(composed), await actionDigest(decomposed));
  });

  it('normalization does not merge strings that really differ', async () => {
    const one = baseRequest({ action: { summary: NFC } }).action;
    const other = baseRequest({ action: { summary: 'cafe' } }).action;
    notStrictEqual(await actionDigest(one), await actionDigest(other));
  });

  it('nfcDeep reaches nested values and object keys', () => {
    const normalized = nfcDeep({ [NFD]: [NFD, { x: NFD }] }) as Record<
      string,
      [string, { x: string }]
    >;
    deepStrictEqual(Object.keys(normalized), [NFC]);
    strictEqual(normalized[NFC]![0], NFC);
    strictEqual(normalized[NFC]![1].x, NFC);
  });
});

async function digestOfRawString(text: string): Promise<string> {
  const hashed = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(hashed)) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

function withoutDigest<T extends { digest?: string }>(value: T): Omit<T, 'digest'> {
  const { digest: _self, ...rest } = value;
  return rest;
}

describe('decision_id', () => {
  it('is hash(action_digest, evidence_state_digest, policy_id, policy_version)', async () => {
    const policy = basePolicy();
    const decision = decide(policy, baseRequest(), DIGESTS, { computed_at: AT });
    const expected = await decisionId({
      action_digest: DIGESTS.action_digest,
      evidence_state_digest: DIGESTS.evidence_state_digest,
      policy_id: policy.policy_id,
      policy_version: policy.version,
    });
    strictEqual(decision.decision_id, expected);
    strictEqual(/^sha256:[0-9a-f]{64}$/.test(decision.decision_id), true);
  });

  it('changes when the policy version changes, with identical evidence', () => {
    const request = baseRequest();
    const v1 = decide(basePolicy(), request, DIGESTS, { computed_at: AT });
    const v2 = decide(basePolicy({ version: '2.0.0' }), request, DIGESTS, { computed_at: AT });
    notStrictEqual(v1.decision_id, v2.decision_id);
    strictEqual(v1.identity.evidence_state_digest, v2.identity.evidence_state_digest);
  });

  it('is stable across repeated computation', () => {
    const policy = basePolicy();
    const request = baseRequest();
    strictEqual(
      decide(policy, request, DIGESTS, { computed_at: AT }).decision_id,
      decide(policy, request, DIGESTS, { computed_at: '2030-01-01T00:00:00Z' }).decision_id,
    );
  });

  it('has a canonical, key-order-independent pre-image', () => {
    strictEqual(
      decisionIdPreimage({
        action_digest: 'sha256:aa',
        evidence_state_digest: 'sha256:bb',
        policy_id: 'p',
        policy_version: '1.0.0',
      }),
      '{"action_digest":"sha256:aa","evidence_state_digest":"sha256:bb","policy_id":"p","policy_version":"1.0.0"}',
    );
  });
});

/**
 * Design §5: the evidence digest is computed over the evidence state *only*.
 * Policy is not an input to it, and that exclusion is what lets `attribute()`
 * tell a policy change apart from an evidence change.
 */
describe('evidence_state_digest excludes policy', () => {
  const evidence_state = { items: [passingEvidence()] };

  it('two decisions under different policies share both identity digests', async () => {
    const digests: RequestDigests = {
      action_digest: await actionDigest(baseRequest().action),
      evidence_state_digest: await evidenceStateDigest(evidence_state),
    };
    const lenient = decide(basePolicy(), baseRequest({ evidence_state }), digests, { computed_at: AT });
    const strict = decide(
      basePolicy({ policy_id: 'strict-policy', risk: { max_impact: 'none' } }),
      baseRequest({ evidence_state }),
      digests,
      { computed_at: AT },
    );

    // The boundary moved...
    notStrictEqual(lenient.outcome, strict.outcome);
    // ...but nothing about the evidence did.
    strictEqual(lenient.identity.evidence_state_digest, strict.identity.evidence_state_digest);
    strictEqual(lenient.identity.action_digest, strict.identity.action_digest);

    const result = attribute(lenient, strict);
    strictEqual(result.cause, 'policy_change');
    deepStrictEqual(result.changed_components, ['policy_id']);
    deepStrictEqual(result.outcome_transition, { from: 'auto_apply', to: 'human_required' });
  });

  it('the digest ignores every policy field, including the ones it reads', async () => {
    // Tightening minimum_assurance changes which items *qualify*, which changes
    // the verdict — and still must not change the hash of the evidence itself.
    const before = await evidenceStateDigest(evidence_state);
    const strict = basePolicy({
      evidence: {
        required: true,
        accepted_modes: ['executable_test'],
        minimum_count: 1,
        minimum_assurance: 'formal_verified',
      },
    });
    const decision = decide(strict, baseRequest({ evidence_state }), {
      action_digest: await actionDigest(baseRequest().action),
      evidence_state_digest: before,
    }, { computed_at: AT });

    strictEqual(decision.outcome, 'incomplete');
    strictEqual(await evidenceStateDigest(evidence_state), before);
    strictEqual(decision.identity.evidence_state_digest, before);
  });
});
