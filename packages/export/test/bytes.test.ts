import { describe, expect, it } from 'vitest';
import { ByteWriter, encodeUtf8 } from '@panorama/export';

describe('ByteWriter', () => {
  it('writes every scalar little-endian', () => {
    const writer = new ByteWriter(4);
    writer.u8(0xff);
    writer.u16(0x1234);
    writer.u32(0xdead_beef);
    writer.i32(-2);
    writer.i64(-1n);
    writer.f64(1.5);
    const bytes = writer.view();
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0x34, 0x12]);
    expect([...bytes.slice(3, 7)]).toEqual([0xef, 0xbe, 0xad, 0xde]);
    expect([...bytes.slice(7, 11)]).toEqual([0xfe, 0xff, 0xff, 0xff]);
    expect([...bytes.slice(11, 19)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getFloat64(19, true)).toBe(1.5);
    expect(writer.length).toBe(27);
  });

  it('truncates a byte to its low eight bits', () => {
    const writer = new ByteWriter();
    writer.u8(0x1ff);
    expect(writer.view()[0]).toBe(0xff);
  });

  it('grows past its initial capacity, keeping what was written', () => {
    const writer = new ByteWriter(16);
    const chunk = new Uint8Array(100).fill(7);
    writer.bytes(chunk);
    writer.bytes(chunk);
    expect(writer.length).toBe(200);
    expect(writer.view().every((byte) => byte === 7)).toBe(true);
  });

  it('writes LEB128 varints, one byte per seven bits', () => {
    const cases: readonly (readonly [number, readonly number[]])[] = [
      [0, [0]],
      [1, [1]],
      [127, [127]],
      [128, [0x80, 1]],
      [300, [0xac, 2]],
      [Number.MAX_SAFE_INTEGER, [255, 255, 255, 255, 255, 255, 255, 15]],
    ];
    for (const [value, expected] of cases) {
      const writer = new ByteWriter();
      writer.varint(value);
      expect([...writer.view()]).toEqual([...expected]);
    }
  });

  it('writes bigint varints identically to number ones', () => {
    for (const value of [0, 1, 127, 128, 300, 1_000_000]) {
      const big = new ByteWriter();
      const small = new ByteWriter();
      big.varintBig(BigInt(value));
      small.varint(value);
      expect([...big.view()]).toEqual([...small.view()]);
    }
  });

  it('reuses its capacity after a reset', () => {
    const writer = new ByteWriter(64);
    writer.u32(1);
    writer.reset();
    expect(writer.length).toBe(0);
    writer.u8(9);
    expect([...writer.view()]).toEqual([9]);
  });

  it('encodes text as UTF-8', () => {
    expect([...encodeUtf8('é')]).toEqual([0xc3, 0xa9]);
    expect(encodeUtf8('\u{1F600}')).toHaveLength(4);
  });
});
