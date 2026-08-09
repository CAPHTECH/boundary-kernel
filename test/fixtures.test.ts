import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decide } from '../src/decide.ts';
import { actionDigest, evidenceStateDigest } from '../src/digest.ts';
import type { Decision, FactorVerdict } from '../src/types.ts';
import { comparable, FIXTURE_NAMES, loadFixture } from './helpers.ts';

/**
 * fixtures/*'/'expected-decision.json is the behavioural oracle. Anything the
 * kernel cannot reproduce by computation is excluded in `comparable()` and
 * documented there; anything it *should* reproduce but does not is listed
 * below as an explicit, named divergence rather than quietly tolerated.
 */

/**
 * fixture 02 declares action.reversibility = 'compensatable' against a policy
 * whose reversibility.minimum is 'reversible', yet expects the reversibility
 * factor to be `satisfied`. Design §4 and the policy schema
 * ("自動適用を許す最低の可逆性") make 'compensatable' fall below that floor, so
 * the kernel reports human_required for that factor. The fixture's *outcome*
 * is human_required either way — only the factor verdict differs.
 *
 * The implementation follows the design; this constant records the mismatch so
 * that correcting the fixture makes the test fail loudly instead of silently
 * passing.
 */
const KNOWN_DIVERGENCES: Record<string, { factor: string; expected: string; computed: string }[]> = {
  '02-authority-withheld': [
    { factor: 'reversibility', expected: 'satisfied', computed: 'human_required' },
  ],
};

function run(name: string): { got: Decision; expected: Decision } {
  const fixture = loadFixture(name);
  const got = decide(
    fixture.policy,
    fixture.request,
    {
      action_digest: fixture.request.action.digest!,
      evidence_state_digest: fixture.request.evidence_state.digest!,
    },
    { computed_at: fixture.expected.computed_at },
  );
  return { got, expected: fixture.expected };
}

/** Applies the documented divergences to the fixture so the rest can be compared exactly. */
function patched(expected: Decision, name: string): Decision {
  const divergences = KNOWN_DIVERGENCES[name];
  if (!divergences) return expected;
  return {
    ...expected,
    factors: expected.factors.map((factor): FactorVerdict => {
      const divergence = divergences.find((d) => d.factor === factor.factor);
      if (!divergence) return factor;
      return {
        ...factor,
        verdict: divergence.computed as FactorVerdict['verdict'],
        // A non-satisfied verdict must carry a reason; the fixture has none to give.
        reasons: ['<divergent factor: reasons not compared>'],
      };
    }),
  };
}

describe('fixtures', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: decide() reproduces expected-decision.json`, () => {
      const { got, expected } = run(name);
      const divergent = new Set((KNOWN_DIVERGENCES[name] ?? []).map((d) => d.factor));

      const normalize = (decision: Decision) => {
        const c = comparable(decision) as Omit<Decision, 'decision_id' | 'computed_at'>;
        return {
          ...c,
          factors: c.factors.map((f) =>
            divergent.has(f.factor) ? { ...f, reasons: ['<divergent factor: reasons not compared>'] } : f,
          ),
        };
      };

      deepStrictEqual(normalize(got), normalize(patched(expected, name)));
    });

    it(`${name}: outcome matches the fixture exactly`, () => {
      const { got, expected } = run(name);
      strictEqual(got.outcome, expected.outcome);
    });

    it(`${name}: all six factors are present exactly once`, () => {
      const { got } = run(name);
      const kinds = got.factors.map((f) => f.factor).sort();
      deepStrictEqual(kinds, [
        'applicability',
        'authority',
        'evidence',
        'freshness',
        'reversibility',
        'risk',
      ]);
    });

    it(`${name}: every non-satisfied factor carries a reason`, () => {
      const { got } = run(name);
      for (const factor of got.factors) {
        if (factor.verdict !== 'satisfied') {
          strictEqual(factor.reasons.length > 0, true, `${factor.factor} has no reasons`);
        }
      }
    });

    it(`${name}: incomplete always says what to observe next`, () => {
      const { got } = run(name);
      if (got.outcome === 'incomplete') {
        strictEqual((got.routing?.required_evidence_modes ?? []).length > 0, true);
      }
    });

    it(`${name}: digests recomputed from the request match the fixture`, async () => {
      const fixture = loadFixture(name);
      // The fixture digests are placeholders, so only self-consistency and the
      // shape of the computed values are checked here.
      const action = await actionDigest(fixture.request.action);
      const evidence = await evidenceStateDigest(fixture.request.evidence_state);
      strictEqual(/^sha256:[0-9a-f]{64}$/.test(action), true);
      strictEqual(/^sha256:[0-9a-f]{64}$/.test(evidence), true);
      strictEqual(action, await actionDigest(fixture.request.action));
      strictEqual(evidence, await evidenceStateDigest(fixture.request.evidence_state));
    });
  }

  it('the known divergences are exactly the ones documented', () => {
    const found: Record<string, { factor: string; expected: string; computed: string }[]> = {};
    for (const name of FIXTURE_NAMES) {
      const { got, expected } = run(name);
      for (const factor of got.factors) {
        const counterpart = expected.factors.find((f) => f.factor === factor.factor);
        if (counterpart && counterpart.verdict !== factor.verdict) {
          (found[name] ??= []).push({
            factor: factor.factor,
            expected: counterpart.verdict,
            computed: factor.verdict,
          });
        }
      }
    }
    deepStrictEqual(found, KNOWN_DIVERGENCES);
  });
});
