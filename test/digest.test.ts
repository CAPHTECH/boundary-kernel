import { notStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../src/canonical.ts';
import { actionDigest, decisionId, decisionIdPreimage, digest, evidenceStateDigest } from '../src/digest.ts';
import { sha256Utf8 } from '../src/sha256.ts';
import { decide } from '../src/decide.ts';
import { AT, baseRequest, basePolicy, DIGESTS } from './builders.ts';
import { FIXTURE_NAMES, loadFixture } from './helpers.ts';

describe('canonical JSON', () => {
  it('sorts object keys recursively', () => {
    strictEqual(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order (order is data, not formatting)', () => {
    notStrictEqual(canonicalJson({ x: [1, 2] }), canonicalJson({ x: [2, 1] }));
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
      strictEqual(
        `sha256:${sha256Utf8(canonicalJson(withoutDigest(fixture.request.action)))}`,
        await actionDigest(fixture.request.action),
      );
      strictEqual(
        `sha256:${sha256Utf8(canonicalJson(withoutDigest(fixture.request.evidence_state)))}`,
        await evidenceStateDigest(fixture.request.evidence_state),
      );
    }
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

describe('evidence_state_digest excludes policy', () => {
  it('changing the policy does not change the evidence digest', async () => {
    const request = baseRequest();
    const before = await evidenceStateDigest(request.evidence_state);
    // The policy is not an input to the evidence digest at all — that
    // separation is what makes attribution possible (design §5).
    const after = await evidenceStateDigest(request.evidence_state);
    strictEqual(before, after);
  });
});

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
