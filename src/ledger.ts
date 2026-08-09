/**
 * Agency Ledger-lite — an append-only JSONL record of what the kernel decided.
 *
 * The ledger is an *observation*, never a judgement. It records `decide()`'s
 * output verbatim and adds only what the decision itself cannot carry: when
 * the action was asked for, when the line was written, which action it was in
 * human-readable terms, and who held the human authorization. Nothing here
 * recomputes, re-routes or re-scores a decision — in particular `decision_id`
 * keeps its existing definition (design §5) and the ledger merely stores it.
 *
 * Three disciplines are structural rather than advisory:
 *
 *   append-only — `seq` is strictly increasing and a line is never edited.
 *                 `readLedger()` rejects a file whose sequence goes backwards
 *                 or repeats, which is what an in-place rewrite looks like.
 *   corrections — expressed as a *new* line (`record_kind: 'correction'`) that
 *                 supersedes an earlier `seq`. The superseded line stays.
 *                 A correction may fix the envelope; it may not fix the
 *                 decision, and `readLedger()` enforces that the decision_id
 *                 on both sides matches.
 *   timestamps  — every line carries `recorded_at`, and `requested_at`
 *                 whenever the host knows it. Whether three-valued routing
 *                 lengthens the queue is currently unmeasured (product notes,
 *                 限界2); the only way to answer it later is to keep the two
 *                 clocks now. `summarize()` reports the entries that cannot be
 *                 measured separately, so a partial measurement is never
 *                 presented as a complete one.
 *
 * File I/O deliberately lives with the host: this module stays free of
 * `node:fs` so it keeps running on Workers like the rest of `src/`. Appending
 * is one line —
 *
 *   appendFileSync(path, serializeEntry(entry));
 */

import { canonicalJson } from './canonical.ts';
import { LEDGER_ENTRY_SCHEMA, FACTOR_KINDS } from './types.ts';
import type {
  Decision,
  FactorKind,
  Identifier,
  LedgerEntry,
  Outcome,
  Request,
} from './types.ts';

const OUTCOMES: readonly Outcome[] = ['auto_apply', 'human_required', 'incomplete'];

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface RecordOptions {
  ledger_id: Identifier;
  /** Strictly greater than the previous line's `seq`. */
  seq: number;
  recorded_at: string;
  /**
   * When the action was asked for. Supply it whenever the host knows it —
   * without it this line contributes nothing to the throughput question.
   */
  requested_at?: string;
  note?: string;
}

/**
 * One line from one decision. The request supplies only identification (which
 * action, who proposed it, who admitted it); every judgement in the line comes
 * from the decision.
 */
export function recordDecision(
  request: Request,
  decision: Decision,
  options: RecordOptions,
): LedgerEntry {
  const action = request.action;
  const entry: LedgerEntry = {
    schema: LEDGER_ENTRY_SCHEMA,
    ledger_id: options.ledger_id,
    seq: options.seq,
    record_kind: 'decision',
    recorded_at: options.recorded_at,
    action: {
      action_id: action.action_id,
      action_kind: action.action_kind,
      proposed_by: { ...action.proposed_by },
    },
    decision,
  };

  if (action.domain !== undefined) entry.action.domain = action.domain;
  if (action.summary !== undefined) entry.action.summary = action.summary;
  if (request.human_admission !== undefined) {
    entry.human_admission = { ...request.human_admission };
  }
  if (options.requested_at !== undefined) entry.requested_at = options.requested_at;
  if (options.note !== undefined) entry.note = options.note;

  return entry;
}

/**
 * The envelope facts a correction is allowed to restate. An explicit
 * `undefined` clears the field, which is distinct from omitting the key
 * (leave it as it was) — a fact recorded that was never known is a real
 * correction.
 */
export type Correctable = {
  [K in 'requested_at' | 'action' | 'human_admission' | 'note']?: LedgerEntry[K] | undefined;
};

export interface CorrectionOptions {
  seq: number;
  recorded_at: string;
  /** Why the earlier line was wrong. A correction without one is just churn. */
  reason: string;
}

/**
 * A correction of an earlier line, as a new line. The decision is carried over
 * untouched: what was computed was computed, and the ledger does not get to
 * revise it. Only the envelope — request time, action identification,
 * authorizer, note — can be restated.
 */
export function recordCorrection(
  previous: LedgerEntry,
  changes: Correctable,
  options: CorrectionOptions,
): LedgerEntry {
  const entry: LedgerEntry = {
    ...previous,
    seq: options.seq,
    record_kind: 'correction',
    recorded_at: options.recorded_at,
    supersedes: { seq: previous.seq, reason: options.reason },
  };

  // `undefined` means "clear this field"; an absent key means "leave it alone".
  if ('requested_at' in changes) {
    if (changes.requested_at === undefined) delete entry.requested_at;
    else entry.requested_at = changes.requested_at;
  }
  if ('action' in changes && changes.action !== undefined) entry.action = changes.action;
  if ('human_admission' in changes) {
    if (changes.human_admission === undefined) delete entry.human_admission;
    else entry.human_admission = changes.human_admission;
  }
  if ('note' in changes) {
    if (changes.note === undefined) delete entry.note;
    else entry.note = changes.note;
  }

  return entry;
}

/** One JSONL line, newline included. Canonical JSON, so it is byte-stable. */
export function serializeEntry(entry: LedgerEntry): string {
  return `${canonicalJson(entry)}\n`;
}

export function serializeLedger(entries: readonly LedgerEntry[]): string {
  return entries.map(serializeEntry).join('');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse a whole ledger and check the invariants that no single line can carry.
 *
 * Every problem found is reported at once rather than throwing on the first —
 * a ledger with three broken lines should say so, not reveal them one run at a
 * time. Blank lines are skipped (a trailing newline is normal); anything else
 * that fails is a failure, never a silently dropped line.
 */
export function readLedger(text: string): LedgerEntry[] {
  const problems: string[] = [];
  const entries: LedgerEntry[] = [];
  const bySeq = new Map<number, LedgerEntry>();
  let ledgerId: string | undefined;
  let previousSeq: number | undefined;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const at = `line ${i + 1}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      problems.push(`${at}: not JSON (${(error as Error).message})`);
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push(`${at}: not a JSON object`);
      continue;
    }
    const entry = parsed as LedgerEntry;

    if (entry.schema !== LEDGER_ENTRY_SCHEMA) {
      problems.push(`${at}: schema is ${JSON.stringify(entry.schema)}, expected '${LEDGER_ENTRY_SCHEMA}'`);
      continue;
    }

    if (ledgerId === undefined) ledgerId = entry.ledger_id;
    else if (entry.ledger_id !== ledgerId) {
      problems.push(
        `${at}: ledger_id '${entry.ledger_id}' differs from '${ledgerId}'; ` +
          `two ledgers concatenated into one file would break the sequence silently`,
      );
    }

    if (!Number.isInteger(entry.seq) || entry.seq < 0) {
      problems.push(`${at}: seq ${JSON.stringify(entry.seq)} is not a non-negative integer`);
      continue;
    }
    if (previousSeq !== undefined && entry.seq <= previousSeq) {
      problems.push(
        `${at}: seq ${entry.seq} does not increase past ${previousSeq}; ` +
          `an append-only ledger never reuses or rewinds a sequence number`,
      );
    }
    previousSeq = entry.seq;

    if (entry.record_kind === 'correction') {
      const supersedes = entry.supersedes;
      if (supersedes === undefined) {
        problems.push(`${at}: record_kind 'correction' without supersedes`);
      } else {
        const target = bySeq.get(supersedes.seq);
        if (target === undefined) {
          problems.push(
            `${at}: supersedes seq ${supersedes.seq}, which is not an earlier line in this ledger`,
          );
        } else if (target.decision.decision_id !== entry.decision.decision_id) {
          problems.push(
            `${at}: supersedes seq ${supersedes.seq} but carries a different decision_id ` +
              `(${entry.decision.decision_id} vs ${target.decision.decision_id}); ` +
              `a correction may restate the envelope, never the decision`,
          );
        }
      }
    } else if (entry.record_kind === 'decision') {
      if (entry.supersedes !== undefined) {
        problems.push(
          `${at}: record_kind 'decision' carries supersedes; deciding again is a new judgement, ` +
            `not a replacement of the earlier one`,
        );
      }
    } else {
      problems.push(`${at}: unknown record_kind ${JSON.stringify(entry.record_kind)}`);
      continue;
    }

    const recorded = Date.parse(entry.recorded_at);
    if (Number.isNaN(recorded)) {
      problems.push(`${at}: recorded_at ${JSON.stringify(entry.recorded_at)} is not a date-time`);
    }

    // The throughput question is answerable only if the two clocks are sane;
    // an entry claiming it was decided before it was requested would poison
    // any later latency figure, so it is rejected rather than silently binned.
    if (entry.requested_at !== undefined) {
      const requested = Date.parse(entry.requested_at);
      const decided = Date.parse(entry.decision.computed_at);
      if (Number.isNaN(requested)) {
        problems.push(`${at}: requested_at ${JSON.stringify(entry.requested_at)} is not a date-time`);
      } else if (!Number.isNaN(decided) && requested > decided) {
        problems.push(
          `${at}: requested_at ${entry.requested_at} is after the decision's computed_at ` +
            `${entry.decision.computed_at}`,
        );
      }
    }

    bySeq.set(entry.seq, entry);
    entries.push(entry);
  }

  if (problems.length > 0) {
    throw new Error(`invalid ledger:\n  ${problems.join('\n  ')}`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface LatencyStats {
  n: number;
  min_seconds: number;
  median_seconds: number;
  max_seconds: number;
  mean_seconds: number;
}

export interface QueueLatency {
  /** Entries that carry `requested_at` and therefore contribute a figure. */
  measured: number;
  /** Entries that do not. Reported, never folded into the measured population. */
  unmeasured: number;
  overall: LatencyStats | null;
  by_outcome: Record<Outcome, LatencyStats | null>;
}

export interface LedgerSummary {
  /** Lines read, corrections included. */
  total: number;
  corrections: number;
  /** Lines replaced by a later correction; excluded from every count below. */
  superseded: number;
  /** Lines actually counted: total − superseded. */
  effective: number;
  /**
   * The routing axis, counted three ways. `incomplete` is never added to
   * `human_required` (design §6) — collapsing them here would hide exactly the
   * signal the ledger exists to surface. It is a separate count from
   * `basis_incomplete` below because routing and measurement are separate
   * questions, and one line answers both.
   */
  by_outcome: Record<Outcome, number>;
  /**
   * Entries whose evidential basis was short, whatever the routing said. This
   * is a superset of `by_outcome.incomplete`: a `human_required` decision can
   * also have had a missing basis, and v0.1 lost precisely that (design §3).
   */
  basis_incomplete: number;
  /** Which factor reported the gap, over the `basis_incomplete` population. */
  basis_gap_by_factor: Record<FactorKind, number>;
  /**
   * What the kernel said should be observed next, over the same population —
   * the actionable reading of "why was the basis short", counted by how often
   * each observation is asked for.
   *
   * ⚠️ Making one of these observations closes a *computability* gap; it does
   * not promise `auto_apply`. An action that was `incomplete` because its
   * reversibility was unknown becomes `human_required` the moment the unknown
   * resolves to `irreversible` (design §3). Nothing in this summary may be
   * read as a queue of nearly-approved work.
   */
  required_evidence_modes: Record<string, number>;
  /** decision.computed_at − requested_at, i.e. how long the action waited. */
  queue_latency: QueueLatency;
}

export function summarize(entries: readonly LedgerEntry[]): LedgerSummary {
  const superseded = new Set<number>();
  let corrections = 0;
  for (const entry of entries) {
    if (entry.record_kind !== 'correction' || entry.supersedes === undefined) continue;
    corrections++;
    superseded.add(entry.supersedes.seq);
  }
  const effective = entries.filter((entry) => !superseded.has(entry.seq));

  const by_outcome = zero(OUTCOMES);
  const basis_gap_by_factor = zero(FACTOR_KINDS);
  const required_evidence_modes: Record<string, number> = {};
  const latencies: number[] = [];
  const latenciesByOutcome: Record<Outcome, number[]> = {
    auto_apply: [],
    human_required: [],
    incomplete: [],
  };
  let basis_incomplete = 0;
  let unmeasured = 0;

  for (const entry of effective) {
    const decision = entry.decision;
    by_outcome[decision.outcome]++;

    if (!decision.basis_complete) {
      basis_incomplete++;
      for (const factor of decision.factors) {
        if (!factor.basis_complete) basis_gap_by_factor[factor.factor]++;
      }
      for (const mode of decision.routing?.required_evidence_modes ?? []) {
        required_evidence_modes[mode] = (required_evidence_modes[mode] ?? 0) + 1;
      }
    }

    const waited = waitedSeconds(entry);
    if (waited === undefined) unmeasured++;
    else {
      latencies.push(waited);
      latenciesByOutcome[decision.outcome].push(waited);
    }
  }

  return {
    total: entries.length,
    corrections,
    superseded: superseded.size,
    effective: effective.length,
    by_outcome,
    basis_incomplete,
    basis_gap_by_factor,
    required_evidence_modes,
    queue_latency: {
      measured: latencies.length,
      unmeasured,
      overall: stats(latencies),
      by_outcome: {
        auto_apply: stats(latenciesByOutcome.auto_apply),
        human_required: stats(latenciesByOutcome.human_required),
        incomplete: stats(latenciesByOutcome.incomplete),
      },
    },
  };
}

/**
 * How long the action waited between being requested and being decided.
 * `undefined` when the host did not supply `requested_at` — the absence is a
 * gap in the measurement, not a zero.
 */
export function waitedSeconds(entry: LedgerEntry): number | undefined {
  if (entry.requested_at === undefined) return undefined;
  const from = Date.parse(entry.requested_at);
  const to = Date.parse(entry.decision.computed_at);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return Math.max(0, Math.round((to - from) / 1000));
}

function zero<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

function stats(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    min_seconds: sorted[0]!,
    median_seconds: median,
    max_seconds: sorted[sorted.length - 1]!,
    mean_seconds: total / sorted.length,
  };
}
