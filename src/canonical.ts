/**
 * Canonical JSON: a deterministic serialization used as the pre-image of every
 * digest the kernel produces.
 *
 * Rules:
 *   - object keys sorted by UTF-16 code unit order, recursively
 *   - no insignificant whitespace
 *   - `undefined` object members are dropped (JSON has no such value)
 *   - arrays keep their order: this is a serializer, and to it every array is
 *     a sequence. Arrays that are *sets* by contract are put into canonical
 *     order beforehand by `normalize.ts` — deciding what an array means is not
 *     the serializer's job
 *   - strings are written as-is: no Unicode normalization happens here, for
 *     the same reason (RFC 8785 leaves it to the application). Digest inputs
 *     are NFC-normalized in `normalize.ts` instead
 *   - non-finite numbers and functions/symbols are rejected rather than
 *     silently turned into `null` — a digest must never hide a lost value
 *
 * Two structurally equal values always canonicalize to the same string,
 * regardless of the key insertion order of the inputs.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return write(value, '<root>');
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      // JSON.stringify gives the shortest round-trippable representation,
      // which is deterministic across engines for finite doubles.
      return JSON.stringify(value);

    case 'string':
      return JSON.stringify(value);

    case 'object': {
      if (Array.isArray(value)) {
        const parts = value.map((item, i) =>
          item === undefined ? 'null' : write(item, `${path}[${i}]`),
        );
        return `[${parts.join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const member = record[key];
        if (member === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${write(member, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }

    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value} at ${path}`);
  }
}
