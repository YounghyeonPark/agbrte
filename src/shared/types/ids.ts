/**
 * Identifier types and generation.
 *
 * Session, agent, and event ids are UUIDv7: a 48-bit millisecond timestamp
 * followed by randomness, so lexicographic order matches creation order. That
 * matters because the dashboard sorts by recency and the SQLite index (§5.1)
 * range-scans by id prefix.
 *
 * `seq` — not an id — is what orders events within a log. Timestamps are
 * advisory (DESIGN.md §5.4d): a transcript can span machines whose clocks
 * differ by tens of seconds, so nothing downstream may sort by time.
 */

/** Branded string, so a SessionId can't be passed where an AgentId is wanted. */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type EventId = Brand<string, 'EventId'>;
/** Repository lineage — travels with a clone (§5.2). */
export type LineageId = Brand<string, 'LineageId'>;
/** One checkout on one machine (§5.2). */
export type InstanceId = Brand<string, 'InstanceId'>;
export type Sha256 = Brand<string, 'Sha256'>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * UUIDv7 per RFC 9562: 48-bit big-endian unix_ts_ms, version 7, 12 bits of
 * randomness, variant 0b10, then 62 more random bits.
 *
 * Node has no built-in v7 (`crypto.randomUUID` is v4, which is not sortable),
 * and the layout is small enough that a dependency isn't worth it.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit timestamp. Split to stay inside safe-integer bitwise range.
  const hi = Math.floor(now / 0x1_0000_0000); // top 16 bits
  const lo = now % 0x1_0000_0000; // low 32 bits
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;

  crypto.getRandomValues(bytes.subarray(6));

  // Version 7 in the high nibble of byte 6.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  // Variant 0b10 in the top two bits of byte 8.
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7, for sanity checks and tests. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

export const newSessionId = (): SessionId => uuidv7() as SessionId;
export const newAgentId = (): AgentId => uuidv7() as AgentId;
export const newEventId = (): EventId => uuidv7() as EventId;
export const newLineageId = (): LineageId => uuidv7() as LineageId;
export const newInstanceId = (): InstanceId => uuidv7() as InstanceId;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Narrow an untrusted string read from disk. Throws rather than corrupting a log. */
export function asSha256(value: string): Sha256 {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`not a sha256: ${value.slice(0, 16)}…`);
  }
  return value as Sha256;
}
