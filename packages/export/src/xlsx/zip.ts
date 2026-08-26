import { ByteWriter, encodeUtf8 } from '../bytes.js';
import { ExportError } from '../format.js';
import type { ByteSink } from '../sink.js';

/**
 * A forward-only ZIP writer.
 *
 * An `.xlsx` file is a ZIP of XML parts, and the sheet is by far the largest of
 * them — so the sheet must be written as it is produced, not assembled and then
 * added. A local file header normally states the size and checksum of the entry
 * that follows, which a streaming writer cannot know yet; ZIP's answer, since
 * 1993, is the *data descriptor*: set bit 3 of the general-purpose flags, leave
 * the three fields zero, and repeat them after the data. Readers take the
 * authoritative copy from the central directory at the end of the file, which
 * this writer knows by then.
 *
 * Deflate comes from the platform's own `CompressionStream`. Sheet XML is
 * extremely repetitive and compresses to a small fraction of its size, so this
 * is the difference between a plausible spreadsheet and an absurd one; where the
 * API is missing the entries are simply stored, which is still a valid ZIP.
 */

const LOCAL_HEADER = 0x04_03_4b_50;
const DATA_DESCRIPTOR = 0x08_07_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

/** 2.0: the version that introduced deflate, which is all this writer needs. */
const VERSION_NEEDED = 20;
/** Bit 3: the sizes and CRC follow the data rather than preceding it. */
const FLAG_DATA_DESCRIPTOR = 0x08;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const UINT32_MAX = 0xff_ff_ff_ff;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/** Running CRC-32, seeded with `0xffffffff` and inverted at the end. */
export const crc32 = (bytes: Uint8Array, seed = 0xff_ff_ff_ff): number => {
  let crc = seed;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return crc;
};

export const finishCrc32 = (crc: number): number => (crc ^ 0xff_ff_ff_ff) >>> 0;

/**
 * MS-DOS date and time, which is what a ZIP records. Two-second resolution and
 * an epoch of 1980 — the format is older than the files it now carries.
 */
export const dosDateTime = (date: Date): { time: number; date: number } => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

interface CentralEntry {
  readonly name: Uint8Array;
  readonly method: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

export interface ZipWriterOptions {
  readonly sink: ByteSink;
  /** Stamped on every entry; one timestamp for the whole archive. */
  readonly modified?: Date;
  /** Off only to make a test's bytes readable, or where deflate is missing. */
  readonly compress?: boolean;
}

/** True when the platform can deflate for us. */
const canDeflate = (): boolean => typeof CompressionStream === 'function';

/**
 * The ceiling of a plain ZIP: every size and offset it records is 32 bits.
 *
 * ZIP64 lifts it, at the cost of a second set of records in every header; a
 * spreadsheet is capped at about a million rows long before its archive
 * approaches 4 GB, so the limit is asserted rather than engineered around.
 */
export const assertEntrySize = (name: string, size: number): void => {
  if (size > UINT32_MAX) {
    throw new ExportError(
      'row-limit',
      `${name} exceeds the 4 GB a spreadsheet archive can hold; export as Parquet or CSV instead`,
    );
  }
};

export class ZipWriter {
  readonly #sink: ByteSink;
  readonly #entries: CentralEntry[] = [];
  readonly #time: number;
  readonly #date: number;
  readonly #compress: boolean;
  readonly #scratch = new ByteWriter(512);

  constructor(options: ZipWriterOptions) {
    this.#sink = options.sink;
    const stamp = dosDateTime(options.modified ?? new Date(1980, 0, 1));
    this.#time = stamp.time;
    this.#date = stamp.date;
    this.#compress = (options.compress ?? true) && canDeflate();
  }

  async #emit(build: (writer: ByteWriter) => void): Promise<void> {
    this.#scratch.reset();
    build(this.#scratch);
    await this.#sink.write(this.#scratch.view());
  }

  /**
   * Adds one entry, whose content is produced by `produce` writing into the
   * callback it is handed. Nothing is buffered: bytes flow through the
   * compressor into the sink as they are written.
   */
  async add(
    name: string,
    produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const nameBytes = encodeUtf8(name);
    const method = this.#compress ? METHOD_DEFLATED : METHOD_STORED;
    const localOffset = this.#sink.position;

    await this.#emit((writer) => {
      writer.u32(LOCAL_HEADER);
      writer.u16(VERSION_NEEDED);
      writer.u16(FLAG_DATA_DESCRIPTOR);
      writer.u16(method);
      writer.u16(this.#time);
      writer.u16(this.#date);
      // CRC and both sizes are unknown until the data has been written, so they
      // are zero here and stated in the data descriptor instead.
      writer.u32(0);
      writer.u32(0);
      writer.u32(0);
      writer.u16(nameBytes.length);
      writer.u16(0);
      writer.bytes(nameBytes);
    });

    let crc = 0xff_ff_ff_ff;
    let uncompressed = 0;
    let compressed = 0;

    if (method === METHOD_STORED) {
      await produce(async (bytes: Uint8Array): Promise<void> => {
        crc = crc32(bytes, crc);
        uncompressed += bytes.length;
        compressed += bytes.length;
        await this.#sink.write(bytes);
      });
    } else {
      const deflate = new CompressionStream('deflate-raw');
      const writer = deflate.writable.getWriter();
      const reader = deflate.readable.getReader();
      // Drains the compressor while the producer fills it; reading and writing
      // one stream from one task would deadlock on the first full queue.
      const drain = (async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done === true) return;
          compressed += value.length;
          await this.#sink.write(value);
        }
      })();
      try {
        await produce(async (bytes: Uint8Array): Promise<void> => {
          crc = crc32(bytes, crc);
          uncompressed += bytes.length;
          await writer.ready;
          await writer.write(bytes.slice());
        });
        await writer.close();
      } catch (error) {
        // Tear the compressor down and let the drain finish however it likes:
        // whatever went wrong with the source is more useful than whatever the
        // compressor has to say about being abandoned half way through.
        await Promise.allSettled([writer.abort(error), drain]);
        throw error;
      }
      await drain;
    }

    assertEntrySize(name, uncompressed);
    assertEntrySize(name, compressed);
    const finalCrc = finishCrc32(crc);

    await this.#emit((writer) => {
      writer.u32(DATA_DESCRIPTOR);
      writer.u32(finalCrc);
      writer.u32(compressed);
      writer.u32(uncompressed);
    });

    this.#entries.push({
      name: nameBytes,
      method,
      time: this.#time,
      date: this.#date,
      crc: finalCrc,
      compressedSize: compressed,
      uncompressedSize: uncompressed,
      localOffset,
    });
  }

  /** Convenience for the small parts, which are strings and fit in memory. */
  async addText(name: string, text: string): Promise<void> {
    const bytes = encodeUtf8(text);
    await this.add(name, async (write) => write(bytes));
  }

  /** Writes the central directory and the end record. */
  async finish(): Promise<void> {
    const start = this.#sink.position;
    for (const entry of this.#entries) {
      await this.#emit((writer) => {
        writer.u32(CENTRAL_HEADER);
        writer.u16(VERSION_NEEDED);
        writer.u16(VERSION_NEEDED);
        writer.u16(FLAG_DATA_DESCRIPTOR);
        writer.u16(entry.method);
        writer.u16(entry.time);
        writer.u16(entry.date);
        writer.u32(entry.crc);
        writer.u32(entry.compressedSize);
        writer.u32(entry.uncompressedSize);
        writer.u16(entry.name.length);
        writer.u16(0);
        writer.u16(0);
        writer.u16(0);
        writer.u16(0);
        writer.u32(0);
        writer.u32(entry.localOffset);
        writer.bytes(entry.name);
      });
    }
    const size = this.#sink.position - start;
    assertEntrySize('The spreadsheet archive', start);
    await this.#emit((writer) => {
      writer.u32(END_OF_CENTRAL_DIRECTORY);
      writer.u16(0);
      writer.u16(0);
      writer.u16(this.#entries.length);
      writer.u16(this.#entries.length);
      writer.u32(size);
      writer.u32(start);
      writer.u16(0);
    });
  }
}
