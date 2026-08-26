/**
 * JSON-RPC 2.0, as MCP frames it: one JSON value per line.
 *
 * Written here rather than taken from a library, for the same reason the Parquet
 * and PDF encoders are: the whole of it is a few dozen lines, the tests can
 * cover every branch of it, and a dependency would bring a tree this project
 * cannot see into. The protocol is small and stable — a version, an id, a method
 * and either a result or an error.
 */

import { isRecord } from './schema.js';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/** The codes the specification defines, and the only ones used here. */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;

export const result = (id: JsonRpcId, value: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result: value,
});

export const failure = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** One line out. Newline-delimited, so a reader needs no length prefix. */
export const encode = (message: JsonRpcResponse): string => `${JSON.stringify(message)}\n`;

/**
 * Reads one line as a request.
 *
 * Returns a response instead when the line cannot be a request at all — a
 * parse error or a missing method — because that is what the caller has to send
 * back, and deciding it here keeps the transport free of protocol judgement.
 */
export const parseRequest = (line: string): JsonRpcRequest | JsonRpcResponse => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return failure(null, PARSE_ERROR, 'Not JSON');
  }
  if (!isRecord(value) || typeof value['method'] !== 'string') {
    return failure(null, INVALID_REQUEST, 'A request needs a method');
  }
  const id = value['id'];
  return {
    jsonrpc: '2.0',
    method: value['method'],
    ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
    ...(value['params'] === undefined ? {} : { params: value['params'] }),
  };
};

export const isResponse = (message: JsonRpcRequest | JsonRpcResponse): message is JsonRpcResponse =>
  (message as JsonRpcResponse).error !== undefined;

/**
 * Splits a byte stream into lines.
 *
 * A stream arrives in whatever chunks the pipe felt like, which is not the same
 * as whatever the sender wrote: a message can be split across two chunks and two
 * messages can share one. So the remainder is kept until its newline turns up.
 */
export class LineReader {
  #pending = '';

  push(chunk: string): readonly string[] {
    this.#pending += chunk;
    const parts = this.#pending.split('\n');
    // The last part is whatever came after the final newline: either nothing, or
    // the beginning of a message still on its way.
    this.#pending = parts.pop() ?? '';
    return parts.map((line) => line.trim()).filter((line) => line !== '');
  }
}
