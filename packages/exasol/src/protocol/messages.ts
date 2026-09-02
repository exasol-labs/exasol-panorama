/**
 * Exasol JSON-over-WebSockets protocol messages.
 *
 * This file is the only place in Panorama that describes wire packets. Nothing
 * outside `@panorama/exasol` may import from it.
 */

export const DEFAULT_PROTOCOL_VERSION = 3;

export interface ExasolRequestBase {
  readonly command: string;
  readonly attributes?: Record<string, unknown>;
}

export interface LoginRequest extends ExasolRequestBase {
  readonly command: 'login';
  readonly protocolVersion: number;
}

export interface LoginTokenRequest extends ExasolRequestBase {
  readonly command: 'loginToken';
  readonly protocolVersion: number;
}

export interface ClientInfo {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly clientOs: string;
  readonly clientRuntime: string;
  readonly useCompression: boolean;
}

export interface PasswordCredentials extends ClientInfo {
  readonly username: string;
  /** RSA/PKCS#1 v1.5 encrypted, base64 encoded. */
  readonly password: string;
}

export interface TokenCredentials extends ClientInfo {
  readonly token: string;
}

export interface ExecuteRequest extends ExasolRequestBase {
  readonly command: 'execute';
  readonly sqlText: string;
}

export interface FetchRequestMessage extends ExasolRequestBase {
  readonly command: 'fetch';
  readonly resultSetHandle: number;
  readonly startPosition: number;
  readonly numBytes: number;
}

export interface CloseResultSetRequest extends ExasolRequestBase {
  readonly command: 'closeResultSet';
  readonly resultSetHandles: readonly number[];
}

export interface DisconnectRequest extends ExasolRequestBase {
  readonly command: 'disconnect';
}

export type ExasolRequest =
  | LoginRequest
  | LoginTokenRequest
  | ExecuteRequest
  | FetchRequestMessage
  | CloseResultSetRequest
  | DisconnectRequest;

export interface ExasolException {
  readonly text: string;
  readonly sqlCode?: string;
}

export interface ExasolResponseBase {
  readonly status: 'ok' | 'error';
  readonly exception?: ExasolException;
  readonly responseData?: unknown;
  readonly attributes?: Record<string, unknown>;
}

export interface LoginChallenge {
  readonly publicKeyPem: string;
  /** Hex-encoded RSA modulus; used directly so no PEM parsing is needed. */
  readonly publicKeyModulus: string;
  /** Hex-encoded RSA public exponent, normally `010001`. */
  readonly publicKeyExponent: string;
}

/**
 * The value formats Panorama pins on every connection.
 *
 * Exasol renders some values *as text* before they reach the protocol, and which
 * text depends on the session's NLS settings — which a database or a user can
 * default however they like. Against a live instance, one `ALTER SESSION` was
 * enough to change what arrived:
 *
 *     default                        "12345678901234567.89"   "2026-09-02"
 *     NLS_NUMERIC_CHARACTERS ',.'    "12345678901234567,89"
 *     NLS_DATE_FORMAT 'DD/MM/YYYY'                            "02/09/2026"
 *
 * A high-precision `DECIMAL` arrives as a string precisely so its digits survive
 * JSON, and every piece of Panorama that reads one assumes a dot: the numeric
 * test in `filterLiteral` that decides whether a followed key is compared as a
 * number or quoted as a string, the `Number()` behind a chart's measure, the
 * date test behind the `month` format hint. None of them would fail loudly on a
 * comma — they would quietly do something else.
 *
 * So the formats are pinned rather than hoped for, and pinning is one round trip
 * at connect. A person who sets their own `ALTER SESSION` afterwards overrides
 * this, which is right: they asked.
 */
export const PINNED_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  /** Decimal separator first, group separator second. */
  numericCharacters: '.,',
  dateFormat: 'YYYY-MM-DD',
  datetimeFormat: 'YYYY-MM-DD HH24:MI:SS.FF6',
});

export interface SessionInfo {
  readonly sessionId: number;
  readonly protocolVersion: number;
  readonly releaseVersion: string;
  readonly databaseName: string;
  readonly productName: string;
  readonly maxDataMessageSize: number;
  readonly maxIdentifierLength: number;
  readonly maxVarcharLength: number;
  readonly identifierQuoteString: string;
  readonly timeZone: string;
  readonly timeZoneBehavior: string;
}

export interface ExasolColumnType {
  readonly type: string;
  readonly precision?: number;
  readonly scale?: number;
  readonly size?: number;
  readonly characterSet?: string;
  readonly withLocalTimeZone?: boolean;
  readonly fraction?: number;
  readonly srid?: number;
}

export interface ExasolColumn {
  readonly name: string;
  readonly dataType: ExasolColumnType;
}

/** Raw protocol value: JSON scalars only. */
export type ExasolValue = string | number | boolean | null;

export interface ExasolResultSet {
  readonly resultType: 'resultSet';
  readonly resultSet: {
    readonly numColumns: number;
    readonly numRows: number;
    readonly numRowsInMessage: number;
    /** Absent when the whole result fitted into the response. */
    readonly resultSetHandle?: number;
    readonly columns: readonly ExasolColumn[];
    /** Column-oriented: `data[column][row]`. */
    readonly data?: readonly (readonly ExasolValue[])[];
  };
}

export interface ExasolRowCountResult {
  readonly resultType: 'rowCount';
  readonly rowCount: number;
}

export type ExasolResult = ExasolResultSet | ExasolRowCountResult;

export interface ExecuteResponseData {
  readonly numResults: number;
  readonly results: readonly ExasolResult[];
}

export interface FetchResponseData {
  readonly numRows: number;
  readonly data: readonly (readonly ExasolValue[])[];
}

export const isResultSet = (result: ExasolResult): result is ExasolResultSet =>
  result.resultType === 'resultSet';
