import { describe, expect, it } from 'vitest';
import { remoteSink } from '@panorama/worker';
import type { WorkerToMainMessage } from '@panorama/worker';

describe('remoteSink', () => {
  it('posts each chunk with its buffer transferred, and counts what it sent', async () => {
    const posted: Array<{ message: WorkerToMainMessage; transfer?: Transferable[] }> = [];
    const acks: number[] = [];
    const sink = remoteSink({
      exportId: 7,
      post: (message, transfer): void => {
        posted.push({ message, ...(transfer === undefined ? {} : { transfer }) });
      },
      waitForAck: async (sequence): Promise<void> => {
        acks.push(sequence);
      },
    });

    const scratch = new Uint8Array([1, 2, 3]);
    await sink.write(scratch);
    // Reusing the caller's buffer must not change what was sent.
    scratch.fill(9);
    await sink.write(new Uint8Array([4]));

    expect(sink.position).toBe(4);
    expect(acks).toEqual([1, 2]);
    expect(posted).toHaveLength(2);
    const first = posted[0]?.message;
    if (first?.type !== 'exportChunk') throw new Error('expected a chunk');
    expect(first.exportId).toBe(7);
    expect(first.sequence).toBe(1);
    expect([...new Uint8Array(first.bytes)]).toEqual([1, 2, 3]);
    // The buffer is handed over rather than copied.
    expect(posted[0]?.transfer).toEqual([first.bytes]);
  });

  it('leaves closing the file to the thread that owns it', async () => {
    const sink = remoteSink({
      exportId: 1,
      post: (): void => undefined,
      waitForAck: async (): Promise<void> => undefined,
    });
    await expect(sink.close()).resolves.toBeUndefined();
    expect(sink.position).toBe(0);
  });
});
