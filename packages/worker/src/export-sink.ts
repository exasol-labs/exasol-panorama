import type { ByteSink } from '@panorama/export';
import type { WorkerToMainMessage } from './messages.js';

/**
 * A sink that lives in the worker and writes to the main thread.
 *
 * The bytes are encoded here, next to the connection, and the file they end up
 * in belongs to a save dialog over there. So each chunk is posted with its
 * buffer *transferred* — moved, not copied — and the sink then waits to be told
 * the main thread has written it before encoding any more. That wait is the
 * whole point: without it a fast database and a slow disk turn into an
 * ever-growing queue of chunks in the message port, which is an
 * out-of-memory failure wearing an export's clothing.
 */

export interface RemoteSinkOptions {
  readonly exportId: number;
  readonly post: (message: WorkerToMainMessage, transfer?: Transferable[]) => void;
  /** Resolved by the matching `exportAck`, and rejected if the export dies. */
  readonly waitForAck: (sequence: number) => Promise<void>;
}

export const remoteSink = (options: RemoteSinkOptions): ByteSink => {
  let position = 0;
  let sequence = 0;
  return {
    get position(): number {
      return position;
    },
    async write(bytes: Uint8Array): Promise<void> {
      // A fresh buffer, because the one handed in is a view into an encoder's
      // scratch space that is about to be reused — and because only a buffer
      // owned outright can be transferred.
      const copy = bytes.slice();
      position += copy.length;
      sequence += 1;
      const pending = options.waitForAck(sequence);
      options.post(
        { type: 'exportChunk', exportId: options.exportId, sequence, bytes: copy.buffer },
        [copy.buffer],
      );
      await pending;
    },
    async close(): Promise<void> {
      /* The file is the main thread's to close; it knows when the last chunk landed. */
    },
  };
};
