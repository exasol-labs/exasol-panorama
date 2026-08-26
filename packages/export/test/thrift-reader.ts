/**
 * A Thrift compact-protocol *reader*, for the tests only.
 *
 * The writer in `src/parquet/thrift.ts` is the only thing standing between
 * Panorama and a Parquet file no tool can open, so the tests read its output
 * back rather than comparing it against bytes someone typed in. This reader is
 * written from the specification independently of the writer — it decodes field
 * headers, zigzag varints and list headers on its own terms — so a matching
 * misunderstanding in both would have to be made twice.
 */

export type ThriftValue =
  boolean | number | bigint | string | Uint8Array | ThriftStruct | ThriftValue[];

/** Fields by id. Thrift has no names on the wire. */
export type ThriftStruct = Map<number, ThriftValue>;

const T_STOP = 0;
const T_BOOL_TRUE = 1;
const T_BOOL_FALSE = 2;
const T_BYTE = 3;
const T_I16 = 4;
const T_I32 = 5;
const T_I64 = 6;
const T_DOUBLE = 7;
const T_BINARY = 8;
const T_LIST = 9;
const T_SET = 10;
const T_MAP = 11;
const T_STRUCT = 12;

export class ThriftReader {
  readonly #bytes: Uint8Array;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  #u8(): number {
    const value = this.#bytes[this.#offset];
    if (value === undefined) throw new Error('Thrift stream ended');
    this.#offset += 1;
    return value;
  }

  #varint(): bigint {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      const byte = this.#u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  #zigzag(): bigint {
    const raw = this.#varint();
    return (raw >> 1n) ^ -(raw & 1n);
  }

  #binary(): Uint8Array {
    const length = Number(this.#varint());
    const slice = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  #value(type: number): ThriftValue {
    switch (type) {
      case T_BOOL_TRUE:
        return true;
      case T_BOOL_FALSE:
        return false;
      case T_BYTE:
        return this.#u8();
      case T_I16:
      case T_I32:
        return Number(this.#zigzag());
      case T_I64:
        return this.#zigzag();
      case T_DOUBLE: {
        const view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#offset, 8);
        this.#offset += 8;
        return view.getFloat64(0, true);
      }
      case T_BINARY:
        return this.#binary();
      case T_LIST:
      case T_SET:
        return this.list();
      case T_STRUCT:
        return this.struct();
      default:
        throw new Error(`Unsupported Thrift type ${type}`);
    }
  }

  list(): ThriftValue[] {
    const header = this.#u8();
    const elementType = header & 0x0f;
    const short = header >> 4;
    const size = short === 0x0f ? Number(this.#varint()) : short;
    const items: ThriftValue[] = [];
    for (let index = 0; index < size; index += 1) items.push(this.#value(elementType));
    return items;
  }

  struct(): ThriftStruct {
    const fields: ThriftStruct = new Map();
    let lastId = 0;
    for (;;) {
      const header = this.#u8();
      if (header === T_STOP) return fields;
      const type = header & 0x0f;
      const delta = header >> 4;
      const id = delta === 0 ? Number(this.#zigzag()) : lastId + delta;
      lastId = id;
      if (type === T_MAP) throw new Error('Maps are not used by Parquet metadata');
      fields.set(id, this.#value(type));
    }
  }
}

const TEXT = new TextDecoder();

/** Reads a field as text, failing loudly rather than returning `undefined`. */
export const textField = (struct: ThriftStruct, id: number): string => {
  const value = struct.get(id);
  if (!(value instanceof Uint8Array)) throw new Error(`Field ${id} is not binary`);
  return TEXT.decode(value);
};

export const numberField = (struct: ThriftStruct, id: number): number => {
  const value = struct.get(id);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Field ${id} is not numeric`);
  return value;
};

export const structField = (struct: ThriftStruct, id: number): ThriftStruct => {
  const value = struct.get(id);
  if (!(value instanceof Map)) throw new Error(`Field ${id} is not a struct`);
  return value;
};

export const listField = (struct: ThriftStruct, id: number): ThriftValue[] => {
  const value = struct.get(id);
  if (!Array.isArray(value)) throw new Error(`Field ${id} is not a list`);
  return value;
};

export const structList = (struct: ThriftStruct, id: number): ThriftStruct[] =>
  listField(struct, id).map((item) => {
    if (!(item instanceof Map)) throw new Error(`Field ${id} holds a non-struct`);
    return item;
  });

/** Decodes a Parquet file's footer: magic, length prefix and `FileMetaData`. */
export const readParquetFooter = (file: Uint8Array): ThriftStruct => {
  const magic = TEXT.decode(file.slice(0, 4));
  const trailer = TEXT.decode(file.slice(-4));
  if (magic !== 'PAR1' || trailer !== 'PAR1') throw new Error('Not a Parquet file');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const length = view.getUint32(file.length - 8, true);
  return new ThriftReader(file, file.length - 8 - length).struct();
};
