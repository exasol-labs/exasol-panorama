/**
 * A tiny `Result` type. Expected failures (an unknown entity id, an invalid
 * argument from an agent) are returned rather than thrown, so that command
 * dispatch has a total, machine-readable contract.
 */

export interface Ok<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface Err<TError> {
  readonly ok: false;
  readonly error: TError;
}

export type Result<TValue, TError> = Ok<TValue> | Err<TError>;

export const ok = <TValue>(value: TValue): Ok<TValue> => ({ ok: true, value });

export const err = <TError>(error: TError): Err<TError> => ({ ok: false, error });

export const isOk = <TValue, TError>(result: Result<TValue, TError>): result is Ok<TValue> =>
  result.ok;

export const isErr = <TValue, TError>(result: Result<TValue, TError>): result is Err<TError> =>
  !result.ok;

/** Unwraps a result, throwing on failure. Intended for tests and startup code. */
export const unwrap = <TValue, TError>(result: Result<TValue, TError>): TValue => {
  if (result.ok) return result.value;
  throw new Error(`Attempted to unwrap a failed result: ${JSON.stringify(result.error)}`);
};
