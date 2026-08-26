import type { ColumnDataType } from '@panorama/core';
import type { ColumnVector, ResultChunk } from '@panorama/table';
import type { EncoderOptions, RowEncoder } from '../encoder.js';
import { requireVectors } from '../encoder.js';
import { ByteWriter } from '../bytes.js';
import { ExportError } from '../format.js';
import type { ByteSink } from '../sink.js';
import { ThriftCompactWriter, T_I32, T_STRUCT } from './thrift.js';
import { encodeDefinitionLevels, encodeValues } from './encode.js';
import type { ParquetColumn } from './schema.js';
import {
  CONVERTED_DATE,
  CONVERTED_DECIMAL,
  CONVERTED_UTF8,
  LOGICAL_DATE_FIELD,
  LOGICAL_DECIMAL_FIELD,
  LOGICAL_STRING_FIELD,
  parquetColumns,
} from './schema.js';

/**
 * Apache Parquet, v1 data pages, one row group at a time.
 *
 * Parquet is the format in this trio that was designed for exactly this
 * situation: its metadata lives in a *footer*, so a writer never has to know
 * anything about the file before it has written it — no row count, no column
 * statistics, no offsets. That is what lets an arbitrarily large result set
 * stream to disk.
 *
 * What cannot stream is a row group. A column chunk has to be contiguous in the
 * file, so every column of a row group is held until the group is complete and
 * then written out one column after another. That buffer is the writer's entire
 * memory cost, and it is bounded by the thresholds below rather than by the size
 * of the relation: a ten-billion-row export and a ten-row one use the same
 * memory, which is the same promise the row cache makes on the other side of the
 * worker.
 *
 * Pages are uncompressed. Snappy or zstd would roughly halve the file, and both
 * are a compressor this package does not have; the platform offers only the
 * deflate family, which Parquet spells GZIP and which readers support far less
 * uniformly than they support no compression at all. Uncompressed pages are the
 * choice that always opens.
 */

/** Row group thresholds. Whichever is reached first ends the group. */
const ROW_GROUP_BYTES = 32 * 1024 * 1024;
const ROW_GROUP_ROWS = 1_000_000;

const MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x31]);

const PAGE_TYPE_DATA = 0;
const ENCODING_PLAIN = 0;
const ENCODING_RLE = 3;
const CODEC_UNCOMPRESSED = 0;
const REPETITION_OPTIONAL = 1;
/** Format version, not a Panorama version: 1 is the one with v1 data pages. */
const FORMAT_VERSION = 1;
const CREATED_BY = 'Exasol Panorama';

interface PendingChunk {
  /** Fully encoded pages: header, definition levels, then values. */
  readonly pages: Uint8Array[];
  /** Rows covered, nulls included — what a data page calls its value count. */
  rows: number;
  bytes: number;
}

interface WrittenChunk {
  readonly rows: number;
  readonly offset: number;
  readonly bytes: number;
}

interface WrittenGroup {
  readonly rows: number;
  readonly columns: readonly WrittenChunk[];
}

/** A v1 data page header, which precedes the levels and values it describes. */
const pageHeader = (rows: number, payloadBytes: number): Uint8Array => {
  const out = new ByteWriter(48);
  const thrift = new ThriftCompactWriter(out);
  thrift.structBegin();
  thrift.i32(1, PAGE_TYPE_DATA);
  thrift.i32(2, payloadBytes);
  // Equal, because the pages are not compressed. A reader still checks both.
  thrift.i32(3, payloadBytes);
  thrift.structBegin(5);
  thrift.i32(1, rows);
  thrift.i32(2, ENCODING_PLAIN);
  thrift.i32(3, ENCODING_RLE);
  // No repetition levels are written — nothing here is nested — but the field
  // is required, so it names the encoding they would have had.
  thrift.i32(4, ENCODING_RLE);
  thrift.structEnd();
  thrift.structEnd();
  return out.view().slice();
};

const writeSchemaElement = (thrift: ThriftCompactWriter, column: ParquetColumn): void => {
  thrift.structBegin();
  thrift.i32(1, column.physical);
  if (column.typeLength !== undefined) thrift.i32(2, column.typeLength);
  // Every column is optional: every SQL column can be NULL.
  thrift.i32(3, REPETITION_OPTIONAL);
  thrift.string(4, column.name);
  // Both spellings of the logical type. `converted_type` is what readers older
  // than 2018 understand and `logicalType` is what newer ones prefer; writing
  // both is what every mainstream writer does, and costs a few bytes once.
  switch (column.logical) {
    case 'string':
      thrift.i32(6, CONVERTED_UTF8);
      thrift.structBegin(10);
      thrift.structBegin(LOGICAL_STRING_FIELD);
      thrift.structEnd();
      thrift.structEnd();
      break;
    case 'decimal':
      thrift.i32(6, CONVERTED_DECIMAL);
      thrift.i32(7, column.scale as number);
      thrift.i32(8, column.precision as number);
      thrift.structBegin(10);
      thrift.structBegin(LOGICAL_DECIMAL_FIELD);
      thrift.i32(1, column.scale as number);
      thrift.i32(2, column.precision as number);
      thrift.structEnd();
      thrift.structEnd();
      break;
    case 'date':
      thrift.i32(6, CONVERTED_DATE);
      thrift.structBegin(10);
      thrift.structBegin(LOGICAL_DATE_FIELD);
      thrift.structEnd();
      thrift.structEnd();
      break;
    case 'none':
      break;
  }
  thrift.structEnd();
};

const writeColumnChunk = (
  thrift: ThriftCompactWriter,
  column: ParquetColumn,
  chunk: WrittenChunk,
): void => {
  thrift.structBegin();
  thrift.i64(2, BigInt(chunk.offset));
  thrift.structBegin(3);
  thrift.i32(1, column.physical);
  // PLAIN for the values, RLE for the definition levels.
  thrift.listBegin(2, T_I32, 2);
  thrift.elementI32(ENCODING_PLAIN);
  thrift.elementI32(ENCODING_RLE);
  // A flat schema, so a column's path is just its name.
  thrift.listBegin(3, 8, 1);
  thrift.elementString(column.name);
  thrift.i32(4, CODEC_UNCOMPRESSED);
  thrift.i64(5, BigInt(chunk.rows));
  thrift.i64(6, BigInt(chunk.bytes));
  thrift.i64(7, BigInt(chunk.bytes));
  thrift.i64(9, BigInt(chunk.offset));
  thrift.structEnd();
  thrift.structEnd();
};

const fileMetadata = (
  columns: readonly ParquetColumn[],
  groups: readonly WrittenGroup[],
  rows: number,
): Uint8Array => {
  const out = new ByteWriter(1024);
  const thrift = new ThriftCompactWriter(out);
  thrift.structBegin();
  thrift.i32(1, FORMAT_VERSION);
  // The schema is a flat list in depth-first order: a root naming how many
  // children follow, then the columns.
  thrift.listBegin(2, T_STRUCT, columns.length + 1);
  thrift.structBegin();
  thrift.string(4, 'schema');
  thrift.i32(5, columns.length);
  thrift.structEnd();
  for (const column of columns) writeSchemaElement(thrift, column);
  thrift.i64(3, BigInt(rows));
  thrift.listBegin(4, T_STRUCT, groups.length);
  for (const group of groups) {
    thrift.structBegin();
    thrift.listBegin(1, T_STRUCT, group.columns.length);
    for (let index = 0; index < group.columns.length; index += 1) {
      writeColumnChunk(
        thrift,
        columns[index] as ParquetColumn,
        group.columns[index] as WrittenChunk,
      );
    }
    let total = 0;
    for (const chunk of group.columns) total += chunk.bytes;
    thrift.i64(2, BigInt(total));
    thrift.i64(3, BigInt(group.rows));
    thrift.structEnd();
  }
  thrift.string(6, CREATED_BY);
  thrift.structEnd();
  return out.view().slice();
};

export interface ParquetOptions {
  readonly rowGroupBytes?: number;
  readonly rowGroupRows?: number;
}

export const createParquetEncoder = (options: EncoderOptions & ParquetOptions): RowEncoder => {
  const { schema, sink } = options;
  if (schema.columns.length === 0) {
    throw new ExportError('no-columns', 'A Parquet file needs at least one column');
  }
  const columns = parquetColumns(schema.columns);
  const types: readonly ColumnDataType[] = schema.columns.map((column) => column.type);
  const groupBytes = options.rowGroupBytes ?? ROW_GROUP_BYTES;
  const groupRows = options.rowGroupRows ?? ROW_GROUP_ROWS;

  let pending: PendingChunk[] = columns.map(() => ({ pages: [], rows: 0, bytes: 0 }));
  let pendingRows = 0;
  let pendingBytes = 0;
  let totalRows = 0;
  const groups: WrittenGroup[] = [];
  const scratch = new ByteWriter(1 << 16);

  const flush = async (target: ByteSink): Promise<void> => {
    if (pendingRows === 0) return;
    const written: WrittenChunk[] = [];
    for (const chunk of pending) {
      const offset = target.position;
      let bytes = 0;
      for (const page of chunk.pages) {
        bytes += page.length;
        await target.write(page);
      }
      written.push({ rows: chunk.rows, offset, bytes });
    }
    groups.push({ rows: pendingRows, columns: written });
    pending = columns.map(() => ({ pages: [], rows: 0, bytes: 0 }));
    pendingRows = 0;
    pendingBytes = 0;
  };

  return {
    async begin(): Promise<void> {
      await sink.write(MAGIC);
    },

    async write(batch: ResultChunk): Promise<void> {
      if (batch.rowCount === 0) return;
      requireVectors(batch, columns.length);
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index] as ParquetColumn;
        const vector = batch.columns[index] as ColumnVector;
        const chunk = pending[index] as PendingChunk;
        const levels = encodeDefinitionLevels(vector, batch.rowCount);
        scratch.reset();
        encodeValues(column, types[index] as ColumnDataType, vector, batch.rowCount, scratch);
        const values = scratch.view();

        // One page per batch per column: the batch is already the right size for
        // a page, and it means nothing has to be re-encoded when a row group is
        // longer than a batch.
        const header = pageHeader(batch.rowCount, levels.length + values.length);
        const page = new Uint8Array(header.length + levels.length + values.length);
        page.set(header, 0);
        page.set(levels, header.length);
        page.set(values, header.length + levels.length);
        chunk.pages.push(page);
        chunk.rows += batch.rowCount;
        chunk.bytes += page.length;
        pendingBytes += page.length;
      }
      pendingRows += batch.rowCount;
      totalRows += batch.rowCount;
      if (pendingRows >= groupRows || pendingBytes >= groupBytes) await flush(sink);
    },

    async finish(): Promise<void> {
      await flush(sink);
      const footer = fileMetadata(columns, groups, totalRows);
      await sink.write(footer);
      const trailer = new ByteWriter(8);
      trailer.u32(footer.length);
      trailer.bytes(MAGIC);
      await sink.write(trailer.view());
    },
  };
};
