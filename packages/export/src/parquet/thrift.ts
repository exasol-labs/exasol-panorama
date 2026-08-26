import type { ByteWriter } from '../bytes.js';
import { encodeUtf8 } from '../bytes.js';

/**
 * Thrift's compact protocol, write side.
 *
 * Parquet's file metadata is a Thrift structure, and there is no way to write a
 * Parquet file without being able to serialise one. Only the write half of one
 * protocol is needed, and only the handful of types Parquet's schema actually
 * uses, so this is a page of code rather than a dependency.
 *
 * Two things make the encoding compact and are the whole of its subtlety.
 * Field ids are written as a *delta* from the previous field in the same struct
 * when the gap fits in four bits, which means the writer has to remember where
 * it is — hence the stack, pushed on entering a nested struct and popped on
 * leaving it. And a boolean field has no payload at all: the value is carried in
 * the type nibble of its own header.
 */

export const T_BOOL_TRUE = 1;
export const T_BOOL_FALSE = 2;
export const T_I32 = 5;
export const T_I64 = 6;
export const T_BINARY = 8;
export const T_LIST = 9;
export const T_STRUCT = 12;

const STOP = 0;
/** Deltas of 1..15 fit the header's high nibble; anything else is written long. */
const MAX_DELTA = 15;
const LONG_LIST_SIZE = 15;
const U64_MASK = 0xff_ff_ff_ff_ff_ff_ff_ffn;

export class ThriftCompactWriter {
  readonly #out: ByteWriter;
  /** The last field id written in each open struct, innermost last. */
  readonly #fieldIds: number[] = [0];

  constructor(out: ByteWriter) {
    this.#out = out;
  }

  #zigzag32(value: number): void {
    this.#out.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  #zigzag64(value: bigint): void {
    this.#out.varintBig(((value << 1n) ^ (value >> 63n)) & U64_MASK);
  }

  #fieldHeader(id: number, type: number): void {
    const last = this.#fieldIds[this.#fieldIds.length - 1] as number;
    const delta = id - last;
    if (delta > 0 && delta <= MAX_DELTA) {
      this.#out.u8((delta << 4) | type);
    } else {
      this.#out.u8(type);
      this.#zigzag32(id);
    }
    this.#fieldIds[this.#fieldIds.length - 1] = id;
  }

  /** Opens a nested struct as field `id`, or the outermost one when omitted. */
  structBegin(id?: number): void {
    if (id !== undefined) this.#fieldHeader(id, T_STRUCT);
    this.#fieldIds.push(0);
  }

  structEnd(): void {
    this.#out.u8(STOP);
    this.#fieldIds.pop();
  }

  bool(id: number, value: boolean): void {
    this.#fieldHeader(id, value ? T_BOOL_TRUE : T_BOOL_FALSE);
  }

  i32(id: number, value: number): void {
    this.#fieldHeader(id, T_I32);
    this.#zigzag32(value);
  }

  i64(id: number, value: bigint): void {
    this.#fieldHeader(id, T_I64);
    this.#zigzag64(value);
  }

  binary(id: number, value: Uint8Array): void {
    this.#fieldHeader(id, T_BINARY);
    this.#out.varint(value.length);
    this.#out.bytes(value);
  }

  string(id: number, value: string): void {
    this.binary(id, encodeUtf8(value));
  }

  /**
   * Opens a list field. The elements follow with no headers of their own —
   * written with `element*` for scalars, or `structBegin()`/`structEnd()` pairs
   * for a list of structs.
   */
  listBegin(id: number, elementType: number, size: number): void {
    this.#fieldHeader(id, T_LIST);
    if (size < LONG_LIST_SIZE) {
      this.#out.u8((size << 4) | elementType);
    } else {
      this.#out.u8((LONG_LIST_SIZE << 4) | elementType);
      this.#out.varint(size);
    }
  }

  /** One `i32` element of a list. */
  elementI32(value: number): void {
    this.#zigzag32(value);
  }

  /** One `binary` element of a list. */
  elementString(value: string): void {
    const bytes = encodeUtf8(value);
    this.#out.varint(bytes.length);
    this.#out.bytes(bytes);
  }
}
