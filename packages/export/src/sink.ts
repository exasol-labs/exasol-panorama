/**
 * Where encoded bytes go.
 *
 * Every encoder here writes *forwards only* and never seeks, which is what
 * makes a ten-billion-row export possible at all: the file is streamed to disk
 * as it is produced and the process never holds more than one batch. That rules
 * out any format that needs to patch a header afterwards, and it is why the ZIP
 * writer uses data descriptors and the Parquet writer puts its metadata in a
 * footer — both formats were designed for exactly this.
 *
 * `position` is part of the contract because two of the three formats need it:
 * a ZIP central directory and a Parquet footer both record where each part of
 * the file started.
 */
export interface ByteSink {
  /** Bytes written so far, which is the offset the next write lands at. */
  readonly position: number;
  write(bytes: Uint8Array): Promise<void>;
  /** Flushes and releases the underlying resource. Idempotent. */
  close(): Promise<void>;
  /**
   * Abandons the destination. A half-written export is not a small export, it
   * is a corrupt file, so a sink that can discard what it has written — a file
   * stream can — should, rather than leaving one behind under the name the user
   * chose.
   */
  abort?(reason: unknown): Promise<void>;
}

/**
 * Collects everything in memory.
 *
 * For tests, and for the browsers with no `showSaveFilePicker` — there the
 * whole file has to become a `Blob` before it can be handed to a download, so
 * the export is bounded by memory rather than by disk.
 */
export interface CollectingSink extends ByteSink {
  /** Everything written so far, as one buffer. */
  bytes(): Uint8Array;
}

export const collectingSink = (): CollectingSink => {
  const chunks: Uint8Array[] = [];
  let position = 0;
  return {
    get position(): number {
      return position;
    },
    async write(bytes: Uint8Array): Promise<void> {
      // Copied: callers reuse scratch buffers between batches, and a sink that
      // retained a view of one would report whatever it was overwritten with.
      chunks.push(bytes.slice());
      position += bytes.length;
    },
    async close(): Promise<void> {
      /* Nothing to release. */
    },
    async abort(): Promise<void> {
      chunks.length = 0;
      position = 0;
    },
    bytes(): Uint8Array {
      const joined = new Uint8Array(position);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return joined;
    },
  };
};

/**
 * Writes into a `WritableStream` — in the browser, the one behind a
 * `FileSystemFileHandle`, so the bytes land in the file the user picked without
 * ever being held whole.
 */
export const streamSink = (stream: WritableStream<Uint8Array>): ByteSink => {
  const writer = stream.getWriter();
  let position = 0;
  let closed = false;
  return {
    get position(): number {
      return position;
    },
    async write(bytes: Uint8Array): Promise<void> {
      // `ready` is the backpressure signal: disk is slower than encoding, and
      // ignoring it queues the whole file in memory instead of on disk.
      await writer.ready;
      await writer.write(bytes.slice());
      position += bytes.length;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await writer.close();
    },
    async abort(reason: unknown): Promise<void> {
      if (closed) return;
      closed = true;
      await writer.abort(reason);
    },
  };
};

/**
 * Abandons a destination, keeping the failure that caused it.
 *
 * `allSettled` rather than a swallowed rejection: a destination that also fails
 * to be abandoned must not replace the reason the export failed, because that
 * is the one the user needs to read.
 */
export const abandon = async (sink: ByteSink, reason: unknown): Promise<void> => {
  await Promise.allSettled([sink.abort?.(reason)]);
};

/** Small writes coalesced into one large one; 64 KiB is a comfortable disk write. */
export const DEFAULT_BUFFER_BYTES = 65_536;

/**
 * Buffers a sink.
 *
 * The Parquet writer emits a page header as half a dozen tiny pieces and the
 * ZIP writer emits 30-byte records; handing each of those to a file stream
 * separately is thousands of syscalls per megabyte. Buffering keeps the
 * encoders free to write in whatever shape the format is described in.
 */
export const bufferedSink = (target: ByteSink, capacity = DEFAULT_BUFFER_BYTES): ByteSink => {
  const buffer = new Uint8Array(capacity);
  let filled = 0;
  let position = 0;

  const flush = async (): Promise<void> => {
    if (filled === 0) return;
    const pending = filled;
    filled = 0;
    await target.write(buffer.subarray(0, pending));
  };

  return {
    get position(): number {
      return position;
    },
    async write(bytes: Uint8Array): Promise<void> {
      position += bytes.length;
      // A write larger than the buffer would only be split for no reason, so it
      // goes straight through — after the buffer, to keep the order right.
      if (bytes.length >= capacity) {
        await flush();
        await target.write(bytes);
        return;
      }
      if (filled + bytes.length > capacity) await flush();
      buffer.set(bytes, filled);
      filled += bytes.length;
    },
    async close(): Promise<void> {
      await flush();
      await target.close();
    },
    async abort(reason: unknown): Promise<void> {
      // Deliberately not flushed: the buffer holds part of a file nobody wants.
      filled = 0;
      await target.abort?.(reason);
    },
  };
};
