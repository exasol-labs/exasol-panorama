import type { TableDataErrorCode } from '@panorama/table';
import { TableDataError } from '@panorama/table';
import type { ExasolException } from '../protocol/messages.js';

/**
 * Translates Exasol failures into the codes the rest of Panorama switches on.
 * Errors must stay local to the component they affect: a permission error is a
 * table-level problem, a protocol error is connection-level.
 */

/** Exasol SQL codes that mean "this result set no longer exists". */
const EXPIRED_CODES = new Set(['R0001', 'E-EGOD-11']);

export const classifyExasolException = (exception: ExasolException): TableDataErrorCode => {
  const code = exception.sqlCode ?? '';
  const text = exception.text.toLowerCase();
  if (EXPIRED_CODES.has(code)) return 'result-set-expired';
  if (text.includes('result set') && (text.includes('not found') || text.includes('invalid'))) {
    return 'result-set-expired';
  }
  if (text.includes('insufficient privileges') || text.includes('not allowed')) {
    return 'permission-denied';
  }
  if (text.includes('authentication failed') || text.includes('invalid credentials')) {
    return 'authentication-failed';
  }
  if (text.includes('object') && text.includes('not found')) return 'not-found';
  return 'fetch-failed';
};

export const exasolError = (exception: ExasolException): TableDataError => {
  const suffix = exception.sqlCode === undefined ? '' : ` [${exception.sqlCode}]`;
  return new TableDataError(
    classifyExasolException(exception),
    `${exception.text}${suffix}`,
    exception,
  );
};

export { TableDataError };
