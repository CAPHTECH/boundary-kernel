/**
 * Semantic normalization of the values that go into a digest (design §5).
 *
 * `canonicalJson` is a *serializer*: it decides how a value is written, never
 * what the value means. Two things about meaning have to be settled before
 * serialization, and this module is where they live:
 *
 *   1. Sets vs sequences. `requested_dimensions` and `evidence_state.items`
 *      are sets by contract — reordering them says nothing. Digesting them in
 *      whatever order the host happened to build the array made a permutation
 *      look like a content change, and `attribute()` then reported a spurious
 *      `evidence_change`. Set-typed arrays are therefore sorted into a
 *      canonical order here; sequence-typed arrays (`reasons`) are left alone,
 *      because their order is narrative and *is* data.
 *
 *   2. Unicode. `"café"` written NFC and NFD are the same string to a reader
 *      and different byte sequences to SHA-256. Hosts in different languages
 *      will not agree on which form they produce, so digest inputs are
 *      NFC-normalized. This is deliberately *not* done inside `canonicalJson`
 *      (RFC 8785 leaves Unicode normalization to the application for the same
 *      reason): a serializer that silently rewrites its input is no longer a
 *      faithful rendering of it.
 *
 * Which arrays are sets and which are sequences is stated in
 * `docs/00_design.md` §5 and in the schemas, never left implicit.
 */

import {
  AGENCY_DIMENSIONS,
  STALENESS_REASONS,
  type Action,
  type AgencyDimension,
  type EvidenceItem,
  type EvidenceState,
  type StalenessReason,
} from './types.ts';

/** Recursively NFC-normalize every string (object keys included). */
export function nfcDeep<T>(value: T): T {
  if (typeof value === 'string') return value.normalize('NFC') as unknown as T;
  if (Array.isArray(value)) return value.map((item) => nfcDeep(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key.normalize('NFC')] = nfcDeep(member);
    }
    return out as unknown as T;
  }
  return value;
}

/** Order a set of enum members by the enum's own declaration order. */
function byEnumOrder<T extends string>(order: readonly T[]) {
  return (a: T, b: T): number => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    // A value outside the enum is invalid input; keep it, and sort it after
    // the known members by code unit so the result stays total and stable.
    if (ia === -1 || ib === -1) {
      if (ia !== ib) return ia === -1 ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return ia - ib;
  };
}

/**
 * `requested_dimensions` / `granted_dimensions` / `withheld_dimensions` are
 * sets. The canonical order is the GAE vector's own order ⟨O,F,P,J,U,E,L⟩,
 * which reads as the agency vector rather than as an alphabet.
 */
export function sortDimensions(dimensions: readonly AgencyDimension[]): AgencyDimension[] {
  return [...dimensions].sort(byEnumOrder(AGENCY_DIMENSIONS));
}

/** Staleness reasons are a set; canonical order is the taxonomy's own order. */
export function sortStalenessReasons(reasons: readonly StalenessReason[]): StalenessReason[] {
  return [...reasons].sort(byEnumOrder(STALENESS_REASONS));
}

/** Free-vocabulary sets (evidence modes, action kinds, domains): code unit order. */
export function sortStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Evidence items are a set keyed by `evidence_id`. Two items sharing an id is
 * invalid input rather than something to resolve here, so the comparator falls
 * back to a total order over the rest of the content to stay deterministic.
 */
export function sortEvidenceItems(items: readonly EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => {
    if (a.evidence_id !== b.evidence_id) return a.evidence_id < b.evidence_id ? -1 : 1;
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/** An evidence item with its own set-typed members normalized. */
function normalizeEvidenceItem(item: EvidenceItem): EvidenceItem {
  const freshness = item.freshness.reasons
    ? { ...item.freshness, reasons: sortStalenessReasons(item.freshness.reasons) }
    : item.freshness;
  return { ...item, freshness };
}

/**
 * The action as the digest sees it: NFC, sets in canonical order, sequences
 * untouched. `applicability.reasons` is a sequence — the host's narrative.
 */
export function normalizeAction(action: Action): Action {
  const normalized = nfcDeep(action);
  return {
    ...normalized,
    requested_dimensions: sortDimensions(normalized.requested_dimensions),
  };
}

/** The evidence state as the digest sees it. */
export function normalizeEvidenceState(state: EvidenceState): EvidenceState {
  const normalized = nfcDeep(state);
  return {
    ...normalized,
    items: sortEvidenceItems(normalized.items.map(normalizeEvidenceItem)),
  };
}
