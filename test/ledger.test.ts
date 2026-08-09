import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { decide } from '../src/decide.ts';
import {
  readLedger,
  recordCorrection,
  recordDecision,
  serializeEntry,
  serializeLedger,
  summarize,
  waitedSeconds,
} from '../src/ledger.ts';
import type { Decision, LedgerEntry, Request } from '../src/types.ts';
import { AT, baseRequest, basePolicy, DIGESTS } from './builders.ts';
import { FIXTURE_NAMES, loadFixture, ROOT } from './helpers.ts';

const LEDGER_ID = 'test-ledger';

const decision = (overrides: Parameters<typeof baseRequest>[0] = {}): Decision =>
  decide(basePolicy(), baseRequest(overrides), DIGESTS, { computed_at: AT });

function entry(seq: number, options: Partial<Parameters<typeof recordDecision>[2]> = {}): LedgerEntry {
  return recordDecision(baseRequest(), decision(), {
    ledger_id: LEDGER_ID,
    seq,
    recorded_at: '2026-08-09T09:05:02Z',
    ...options,
  });
}

describe('ledger: writing a line', () => {
  it('records the decision verbatim — the ledger observes, it does not judge', () => {
    const d = decision();
    const line = recordDecision(baseRequest(), d, {
      ledger_id: LEDGER_ID,
      seq: 0,
      recorded_at: '2026-08-09T09:05:02Z',
    });
    // Not a projection: the whole decision, byte-identical.
    deepStrictEqual(line.decision, d);
    strictEqual(line.decision.decision_id, d.decision_id);
    strictEqual(line.record_kind, 'decision');
  });

  it('keeps both axes as separate fields', () => {
    const line = entry(0);
    // routing and measurement are two questions; the ledger records both and
    // folds neither into the other (design §3).
    ok('outcome' in line.decision);
    ok('basis_complete' in line.decision);
    strictEqual(typeof line.decision.outcome, 'string');
    strictEqual(typeof line.decision.basis_complete, 'boolean');
  });

  it('adds the identification the decision cannot carry', () => {
    const request = baseRequest();
    const line = recordDecision(request, decision(), {
      ledger_id: LEDGER_ID,
      seq: 0,
      recorded_at: '2026-08-09T09:05:02Z',
    });
    // The decision binds the action by digest only.
    strictEqual(line.decision.identity.action_digest, DIGESTS.action_digest);
    strictEqual(line.action.action_id, request.action.action_id);
    strictEqual(line.action.action_kind, request.action.action_kind);
    strictEqual(line.action.domain, request.action.domain);
    deepStrictEqual(line.action.proposed_by, request.action.proposed_by);
  });

  it('carries the human authorizer when the request names one', () => {
    const request: Request = {
      ...baseRequest(),
      human_admission: { actor: 'human:rizumita', authority: 'representative' },
    };
    const line = recordDecision(request, decision(), {
      ledger_id: LEDGER_ID,
      seq: 0,
      recorded_at: '2026-08-09T09:05:02Z',
    });
    deepStrictEqual(line.human_admission, { actor: 'human:rizumita', authority: 'representative' });
  });

  it('omits requested_at rather than inventing one', () => {
    strictEqual('requested_at' in entry(0), false);
    strictEqual(waitedSeconds(entry(0)), undefined);
  });

  it('measures the wait from requested_at to the decision, not to the line', () => {
    const line = entry(0, {
      requested_at: '2026-08-09T09:00:01Z',
      recorded_at: '2026-08-09T23:00:00Z',
    });
    // computed_at is AT (09:05:01Z); the late write does not lengthen the wait.
    strictEqual(waitedSeconds(line), 300);
  });

  it('serializes to exactly one newline-terminated line', () => {
    const text = serializeEntry(entry(0));
    strictEqual(text.endsWith('\n'), true);
    strictEqual(text.trimEnd().includes('\n'), false);
  });

  it('serializes byte-identically for structurally equal entries', () => {
    strictEqual(serializeEntry(entry(0)), serializeEntry(entry(0)));
  });
});

describe('ledger: corrections are new lines', () => {
  const original = entry(0, { requested_at: '2026-08-09T09:04:00Z' });
  const fixed = recordCorrection(
    original,
    { requested_at: '2026-08-09T08:00:00Z' },
    { seq: 1, recorded_at: '2026-08-09T10:00:00Z', reason: 'the queue log stamped the retry' },
  );

  it('leaves the superseded line untouched', () => {
    strictEqual(original.requested_at, '2026-08-09T09:04:00Z');
    strictEqual(original.seq, 0);
    strictEqual(original.record_kind, 'decision');
  });

  it('points back at what it corrects, with a reason', () => {
    deepStrictEqual(fixed.supersedes, { seq: 0, reason: 'the queue log stamped the retry' });
    strictEqual(fixed.record_kind, 'correction');
    strictEqual(fixed.seq, 1);
  });

  it('restates the envelope but never the decision', () => {
    strictEqual(fixed.requested_at, '2026-08-09T08:00:00Z');
    deepStrictEqual(fixed.decision, original.decision);
  });

  it('can clear an envelope field that should not have been there', () => {
    const cleared = recordCorrection(
      original,
      { requested_at: undefined },
      { seq: 1, recorded_at: '2026-08-09T10:00:00Z', reason: 'the request time was never known' },
    );
    strictEqual('requested_at' in cleared, false);
  });
});

describe('ledger: reading enforces what a single line cannot say', () => {
  const read = (entries: LedgerEntry[]) => readLedger(serializeLedger(entries));

  it('round-trips a well-formed ledger', () => {
    const entries = [entry(0), entry(1), entry(2)];
    deepStrictEqual(read(entries), entries);
  });

  it('ignores blank lines but never a non-empty one', () => {
    strictEqual(readLedger(`\n${serializeEntry(entry(0))}\n\n`).length, 1);
    throws(() => readLedger('{'), /not JSON/);
    throws(() => readLedger('[]\n'), /not a JSON object/);
  });

  it('rejects a rewound or repeated seq — that is what a rewritten line looks like', () => {
    throws(() => read([entry(0), entry(1), entry(1)]), /does not increase past 1/);
    throws(() => read([entry(5), entry(2)]), /does not increase past 5/);
  });

  it('rejects two ledgers concatenated into one file', () => {
    const foreign = { ...entry(1), ledger_id: 'other-ledger' };
    throws(() => read([entry(0), foreign]), /differs from 'test-ledger'/);
  });

  it('rejects a correction that points nowhere or forwards', () => {
    const orphan = { ...entry(1), record_kind: 'correction' as const, supersedes: { seq: 9, reason: 'x' } };
    throws(() => read([entry(0), orphan]), /not an earlier line/);
  });

  it('rejects a correction that rewrites the decision', () => {
    const other = decide(basePolicy({ policy_id: 'other-policy' }), baseRequest(), DIGESTS, {
      computed_at: AT,
    });
    const rewritten: LedgerEntry = {
      ...entry(1),
      record_kind: 'correction',
      supersedes: { seq: 0, reason: 'nope' },
      decision: other,
    };
    throws(
      () => read([entry(0), rewritten]),
      /a correction may restate the envelope, never the decision/,
    );
  });

  it('rejects a plain decision that claims to replace an earlier line', () => {
    const replacing = { ...entry(1), supersedes: { seq: 0, reason: 'x' } };
    throws(() => read([entry(0), replacing]), /deciding again is a new judgement/);
  });

  it('rejects a wait that would come out negative', () => {
    // computed_at is 09:05:01Z.
    const impossible = entry(0, { requested_at: '2026-08-09T10:00:00Z' });
    throws(() => read([impossible]), /is after the decision's computed_at/);
  });

  it('rejects lines from another schema rather than guessing', () => {
    const alien = { ...entry(0), schema: 'rbk.decision.v3' };
    throws(() => read([alien as unknown as LedgerEntry]), /expected 'rbk.ledger_entry.v1'/);
  });

  it('reports every problem at once, not one per run', () => {
    const bad = [entry(0), { ...entry(0), ledger_id: 'other' }];
    try {
      read(bad as LedgerEntry[]);
      throw new Error('expected readLedger to throw');
    } catch (error) {
      const message = (error as Error).message;
      match(message, /differs from/);
      match(message, /does not increase past 0/);
    }
  });
});

describe('ledger: summarizing', () => {
  const stale = () =>
    decide(
      basePolicy(),
      baseRequest({
        evidence_state: {
          items: [
            {
              evidence_id: 'ev-stale',
              mode: 'executable_test',
              outcome: 'passed',
              assurance: 'runtime_observed',
              freshness: { status: 'stale', reasons: ['target_changed'] },
            },
          ],
        },
      }),
      DIGESTS,
      { computed_at: AT },
    );

  const risky = () =>
    decide(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'critical', exposure: 0.1, uncertainty: 0.05 } } }),
      DIGESTS,
      { computed_at: AT },
    );

  /** human_required *and* a short basis at once — the state v0.1 could not hold. */
  const riskyAndBlind = () =>
    decide(
      basePolicy(),
      baseRequest({ action: { risk: { impact: 'critical' }, reversibility: 'unknown' } }),
      DIGESTS,
      { computed_at: AT },
    );

  function ledgerOf(decisions: readonly Decision[]): LedgerEntry[] {
    return decisions.map((d, i) =>
      recordDecision(baseRequest(), d, {
        ledger_id: LEDGER_ID,
        seq: i,
        recorded_at: '2026-08-09T09:05:02Z',
      }),
    );
  }

  it('counts the three outcomes separately', () => {
    const summary = summarize(ledgerOf([decision(), stale(), risky(), risky()]));
    deepStrictEqual(summary.by_outcome, { auto_apply: 1, human_required: 2, incomplete: 1 });
    strictEqual(summary.effective, 4);
  });

  it('never folds incomplete into human_required', () => {
    const summary = summarize(ledgerOf([stale(), stale(), risky()]));
    strictEqual(summary.by_outcome.incomplete, 2);
    strictEqual(summary.by_outcome.human_required, 1);
  });

  it('counts a short basis on its own axis, including under human_required', () => {
    const entries = ledgerOf([riskyAndBlind()]);
    strictEqual(entries[0]!.decision.outcome, 'human_required');
    strictEqual(entries[0]!.decision.basis_complete, false);
    const summary = summarize(entries);
    // Routing says human_required; measurement still records the gap.
    strictEqual(summary.by_outcome.human_required, 1);
    strictEqual(summary.by_outcome.incomplete, 0);
    strictEqual(summary.basis_incomplete, 1);
  });

  it('breaks the basis gap down by the factor that reported it', () => {
    const summary = summarize(ledgerOf([stale(), riskyAndBlind()]));
    strictEqual(summary.basis_incomplete, 2);
    strictEqual(summary.basis_gap_by_factor.freshness, 1);
    strictEqual(summary.basis_gap_by_factor.reversibility, 1);
    strictEqual(summary.basis_gap_by_factor.authority, 0);
    // Every factor kind is present as a key, so a zero is visible as a zero.
    strictEqual(Object.keys(summary.basis_gap_by_factor).length, 6);
  });

  it('counts what should be observed next', () => {
    const summary = summarize(ledgerOf([stale(), stale()]));
    deepStrictEqual(summary.required_evidence_modes, { executable_test: 2 });
  });

  it('excludes a superseded line and counts the correction once', () => {
    const first = recordDecision(baseRequest(), stale(), {
      ledger_id: LEDGER_ID,
      seq: 0,
      recorded_at: '2026-08-09T09:05:02Z',
      requested_at: '2026-08-09T09:04:01Z',
    });
    const fixed = recordCorrection(
      first,
      { requested_at: '2026-08-09T08:05:01Z' },
      { seq: 1, recorded_at: '2026-08-09T10:00:00Z', reason: 'wrong clock' },
    );
    const summary = summarize([first, fixed]);
    strictEqual(summary.total, 2);
    strictEqual(summary.corrections, 1);
    strictEqual(summary.superseded, 1);
    strictEqual(summary.effective, 1);
    strictEqual(summary.by_outcome.incomplete, 1);
    // The corrected time is the one that counts, and only once.
    strictEqual(summary.queue_latency.measured, 1);
    strictEqual(summary.queue_latency.overall?.median_seconds, 3600);
  });

  it('keeps the unmeasured population separate from the measured one', () => {
    const withTime = recordDecision(baseRequest(), decision(), {
      ledger_id: LEDGER_ID,
      seq: 0,
      recorded_at: '2026-08-09T09:05:02Z',
      requested_at: '2026-08-09T09:00:01Z',
    });
    const withoutTime = recordDecision(baseRequest(), decision(), {
      ledger_id: LEDGER_ID,
      seq: 1,
      recorded_at: '2026-08-09T09:05:02Z',
    });
    const summary = summarize([withTime, withoutTime]);
    strictEqual(summary.queue_latency.measured, 1);
    strictEqual(summary.queue_latency.unmeasured, 1);
    // A missing timestamp is a gap in the measurement, never a zero wait.
    strictEqual(summary.queue_latency.overall?.n, 1);
    strictEqual(summary.queue_latency.overall?.mean_seconds, 300);
  });

  it('splits the wait by outcome — the throughput question is per routing', () => {
    const waits: Array<[Decision, string]> = [
      [decision(), '2026-08-09T09:00:01Z'], // auto_apply, 300s
      [stale(), '2026-08-09T08:05:01Z'], // incomplete, 3600s
      [stale(), '2026-08-09T07:05:01Z'], // incomplete, 7200s
    ];
    const entries = waits.map(([d, requested_at], i) =>
      recordDecision(baseRequest(), d, {
        ledger_id: LEDGER_ID,
        seq: i,
        recorded_at: '2026-08-09T09:05:02Z',
        requested_at,
      }),
    );
    const summary = summarize(entries);
    strictEqual(summary.queue_latency.by_outcome.auto_apply?.median_seconds, 300);
    strictEqual(summary.queue_latency.by_outcome.incomplete?.n, 2);
    strictEqual(summary.queue_latency.by_outcome.incomplete?.median_seconds, 5400);
    strictEqual(summary.queue_latency.by_outcome.incomplete?.max_seconds, 7200);
    // No entry routed there, so there is nothing to report — not a zero.
    strictEqual(summary.queue_latency.by_outcome.human_required, null);
  });

  it('is empty, not wrong, on an empty ledger', () => {
    const summary = summarize([]);
    strictEqual(summary.total, 0);
    deepStrictEqual(summary.by_outcome, { auto_apply: 0, human_required: 0, incomplete: 0 });
    strictEqual(summary.queue_latency.overall, null);
  });
});

describe('ledger: the committed fixture', () => {
  const text = readFileSync(join(ROOT, 'fixtures', 'ledger', 'ledger.jsonl'), 'utf8');
  const entries = readLedger(text);

  it('reads back and satisfies the append-only invariants', () => {
    strictEqual(entries.length, 6);
    deepStrictEqual(
      entries.map((e) => e.seq),
      [0, 1, 2, 3, 4, 5],
    );
  });

  it('records each scenario decision exactly as the fixture states it', () => {
    FIXTURE_NAMES.forEach((name, i) => {
      const fixture = loadFixture(name);
      deepStrictEqual(entries[i]!.decision, fixture.expected);
      strictEqual(entries[i]!.action.action_id, fixture.request.action.action_id);
      strictEqual(entries[i]!.decision.request_id, fixture.request.request_id);
    });
  });

  it('summarizes the five scenarios on both axes', () => {
    const summary = summarize(entries);
    strictEqual(summary.total, 6);
    strictEqual(summary.corrections, 1);
    strictEqual(summary.superseded, 1);
    strictEqual(summary.effective, 5);
    deepStrictEqual(summary.by_outcome, { auto_apply: 1, human_required: 3, incomplete: 1 });
    // Two entries had a short basis; only one of them routed to `incomplete`.
    strictEqual(summary.basis_incomplete, 2);
    deepStrictEqual(summary.required_evidence_modes, {
      executable_test: 2,
      static_verification: 1,
    });
  });

  it('leaves the wait unmeasured where the host did not know it', () => {
    const summary = summarize(entries);
    strictEqual(summary.queue_latency.measured, 4);
    strictEqual(summary.queue_latency.unmeasured, 1);
    strictEqual(summary.queue_latency.overall?.min_seconds, 301);
    strictEqual(summary.queue_latency.overall?.max_seconds, 1800);
  });
});
