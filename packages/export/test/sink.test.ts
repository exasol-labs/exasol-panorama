import { describe, expect, it } from 'vitest';
import { DEFAULT_BUFFER_BYTES, bufferedSink, collectingSink, streamSink } from '@panorama/export';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('collectingSink', () => {
  it('joins everything written and tracks the position', async () => {
    const sink = collectingSink();
    await sink.write(bytes(1, 2));
    await sink.write(bytes(3));
    expect(sink.position).toBe(3);
    expect([...sink.bytes()]).toEqual([1, 2, 3]);
    await sink.close();
  });

  it('copies what it is given, so a reused buffer cannot rewrite history', async () => {
    const sink = collectingSink();
    const scratch = bytes(1, 2, 3);
    await sink.write(scratch);
    scratch.fill(9);
    expect([...sink.bytes()]).toEqual([1, 2, 3]);
  });

  it('discards everything on abort', async () => {
    const sink = collectingSink();
    await sink.write(bytes(1, 2, 3));
    await sink.abort?.(new Error('no'));
    expect(sink.position).toBe(0);
    expect([...sink.bytes()]).toEqual([]);
  });
});

describe('bufferedSink', () => {
  it('coalesces small writes into one', async () => {
    const target = collectingSink();
    const writes: number[] = [];
    const counted = {
      get position(): number {
        return target.position;
      },
      async write(value: Uint8Array): Promise<void> {
        writes.push(value.length);
        await target.write(value);
      },
      close: target.close,
    };
    const sink = bufferedSink(counted, 8);
    for (let index = 0; index < 6; index += 1) await sink.write(bytes(index));
    // Nothing has reached the target yet: six bytes fit in the buffer.
    expect(writes).toEqual([]);
    expect(sink.position).toBe(6);
    await sink.close();
    expect(writes).toEqual([6]);
    expect([...target.bytes()]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('flushes before a write that would not fit, keeping the order', async () => {
    const target = collectingSink();
    const sink = bufferedSink(target, 4);
    await sink.write(bytes(1, 2, 3));
    await sink.write(bytes(4, 5));
    await sink.close();
    expect([...target.bytes()]).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes a write larger than the buffer straight through, after the buffer', async () => {
    const target = collectingSink();
    const sink = bufferedSink(target, 4);
    await sink.write(bytes(1));
    await sink.write(bytes(2, 3, 4, 5, 6));
    expect([...target.bytes()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.position).toBe(6);
    await sink.close();
  });

  it('drops the buffer on abort rather than flushing part of a file', async () => {
    const target = collectingSink();
    const sink = bufferedSink(target, 8);
    await sink.write(bytes(1, 2, 3));
    await sink.abort?.(new Error('stopped'));
    expect([...target.bytes()]).toEqual([]);
  });

  it('defaults to a disk-sized buffer', () => {
    expect(DEFAULT_BUFFER_BYTES).toBe(65_536);
    const sink = bufferedSink(collectingSink());
    expect(sink.position).toBe(0);
  });
});

describe('streamSink', () => {
  it('writes through to the stream and closes it once', async () => {
    const written: number[] = [];
    let closed = 0;
    const sink = streamSink(
      new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(...chunk);
        },
        close() {
          closed += 1;
        },
      }),
    );
    await sink.write(bytes(1, 2));
    await sink.write(bytes(3));
    expect(sink.position).toBe(3);
    await sink.close();
    await sink.close();
    expect(written).toEqual([1, 2, 3]);
    expect(closed).toBe(1);
  });

  it('abandons the stream on abort, and abandons it only once', async () => {
    let aborted: unknown = null;
    const sink = streamSink(
      new WritableStream<Uint8Array>({
        abort(reason) {
          aborted = reason;
        },
      }),
    );
    const reason = new Error('cancelled');
    await sink.abort?.(reason);
    await sink.abort?.(new Error('again'));
    expect(aborted).toBe(reason);
  });
});
