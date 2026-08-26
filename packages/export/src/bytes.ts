/**
 * A growable little-endian byte buffer.
 *
 * ZIP records, Parquet pages and Thrift structs are all described as sequences
 * of little-endian fields and length-prefixed blobs, so they are all written
 * through this rather than each doing its own `DataView` arithmetic. Growth
 * doubles, so building a page is amortised linear.
 */
export class ByteWriter {
  #buffer: Uint8Array;
  #view: DataView;
  #length = 0;

  constructor(initialCapacity = 256) {
    this.#buffer = new Uint8Array(Math.max(16, initialCapacity));
    this.#view = new DataView(this.#buffer.buffer);
  }

  get length(): number {
    return this.#length;
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#buffer.length) return;
    let capacity = this.#buffer.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
    this.#view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.#reserve(1);
    this.#buffer[this.#length] = value & 0xff;
    this.#length += 1;
  }

  u16(value: number): void {
    this.#reserve(2);
    this.#view.setUint16(this.#length, value, true);
    this.#length += 2;
  }

  u32(value: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#length, value, true);
    this.#length += 4;
  }

  i32(value: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.#length, value, true);
    this.#length += 4;
  }

  i64(value: bigint): void {
    this.#reserve(8);
    this.#view.setBigInt64(this.#length, value, true);
    this.#length += 8;
  }

  f64(value: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  bytes(value: Uint8Array): void {
    this.#reserve(value.length);
    this.#buffer.set(value, this.#length);
    this.#length += value.length;
  }

  /**
   * Unsigned LEB128, as Thrift's compact protocol and Parquet's RLE hybrid
   * both use. Written from a `number`: every varint in either format is a
   * length, a count or a field delta, all comfortably inside 2^53.
   */
  varint(value: number): void {
    let remaining = value;
    while (remaining >= 0x80) {
      this.u8((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.u8(remaining);
  }

  /** Unsigned LEB128 of a `bigint`, for the 64-bit fields of a Thrift struct. */
  varintBig(value: bigint): void {
    let remaining = value;
    while (remaining >= 0x80n) {
      this.u8(Number(remaining & 0x7fn) | 0x80);
      remaining >>= 7n;
    }
    this.u8(Number(remaining));
  }

  /** The bytes written so far. A view, not a copy: valid until the next write. */
  view(): Uint8Array {
    return this.#buffer.subarray(0, this.#length);
  }

  /** Drops everything written, keeping the capacity for the next page. */
  reset(): void {
    this.#length = 0;
  }
}

export const UTF8 = new TextEncoder();

export const encodeUtf8 = (text: string): Uint8Array => UTF8.encode(text);
