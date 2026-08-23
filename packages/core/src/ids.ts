/**
 * Stable, machine-readable identifiers.
 *
 * Every Panorama object carries an identifier that is meaningful outside the
 * browser session: agents, MCP adapters and replayed history all address
 * objects by these strings, so they are lexicographically sortable (ULID) and
 * prefixed with the object kind.
 */

declare const brandSymbol: unique symbol;

/** Nominal typing helper: `Brand<string, 'EntityId'>` is not assignable from `string`. */
export type Brand<TValue, TBrand extends string> = TValue & {
  readonly [brandSymbol]: TBrand;
};

export type EntityId = Brand<string, 'EntityId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type CommitId = Brand<string, 'CommitId'>;
export type BindingId = Brand<string, 'BindingId'>;

/** Crockford base32, excluding I, L, O and U. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LENGTH = ENCODING.length;
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

/** Largest timestamp a 48-bit ULID time component can represent. */
export const MAX_ULID_TIME = 281_474_976_710_655;

export interface UlidFactoryOptions {
  /** Millisecond clock. Injected so tests can be deterministic. */
  readonly now?: () => number;
  /** Returns a float in [0, 1). Injected so tests can be deterministic. */
  readonly random?: () => number;
}

const encodeTime = (time: number): string => {
  if (!Number.isInteger(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${time}`);
  }
  let remaining = time;
  let out = '';
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    const mod = remaining % ENCODING_LENGTH;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / ENCODING_LENGTH;
  }
  return out;
};

const encodeRandom = (random: () => number): string => {
  let out = '';
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    const value = Math.floor(random() * ENCODING_LENGTH);
    // A `random()` returning exactly 1 would overflow the alphabet.
    out += ENCODING[Math.min(value, ENCODING_LENGTH - 1)];
  }
  return out;
};

/**
 * Creates a monotonic ULID generator. Ids produced within the same millisecond
 * still sort in creation order because the random component is incremented
 * rather than redrawn.
 */
export const createUlidFactory = (options: UlidFactoryOptions = {}): (() => string) => {
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? ((): number => Math.random());
  let lastTime = -1;
  let lastRandom = '';

  return (): string => {
    const time = now();
    if (time === lastTime) {
      lastRandom = incrementBase32(lastRandom);
    } else {
      lastTime = time;
      lastRandom = encodeRandom(random);
    }
    return encodeTime(time) + lastRandom;
  };
};

/** Increments a base32 string with carry; wraps to all zeroes on overflow. */
const incrementBase32 = (value: string): string => {
  const chars = [...value];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] as string;
    const next = ENCODING.indexOf(char) + 1;
    if (next < ENCODING_LENGTH) {
      chars[index] = ENCODING[next] as string;
      return chars.join('');
    }
    chars[index] = ENCODING[0] as string;
  }
  return chars.join('');
};

/** Namespaces used in identifier prefixes. */
export type IdNamespace = 'table' | 'column' | 'connection' | 'commit' | 'binding';

export interface IdFactory {
  entity(namespace: Exclude<IdNamespace, 'commit' | 'connection' | 'binding'>): EntityId;
  connection(): ConnectionId;
  commit(): CommitId;
  binding(): BindingId;
}

/** Creates namespaced id factories sharing one monotonic ULID source. */
export const createIdFactory = (options: UlidFactoryOptions = {}): IdFactory => {
  const ulid = createUlidFactory(options);
  return {
    entity: (namespace): EntityId => `${namespace}:${ulid()}` as EntityId,
    connection: (): ConnectionId => `connection:${ulid()}` as ConnectionId,
    commit: (): CommitId => `commit:${ulid()}` as CommitId,
    binding: (): BindingId => `binding:${ulid()}` as BindingId,
  };
};

/** Returns the namespace of an identifier, or `null` when it is unprefixed. */
export const idNamespace = (id: string): string | null => {
  const separator = id.indexOf(':');
  return separator <= 0 ? null : id.slice(0, separator);
};
