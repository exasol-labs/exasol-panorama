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
