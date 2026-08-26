/**
 * A SQL *reader*, for the tests only.
 *
 * The statements Panorama builds carry values it did not choose: a filter's
 * values are cell contents, which is to say whatever somebody else inserted, and
 * a column name is whatever the catalogue says. Asserting that
 * `quoteLiteral("it's")` equals `'it''s'` only proves we are consistent with
 * ourselves. So this reads a literal back the way a database would — walking to
 * the closing quote, treating a doubled quote as one character of text — written
 * from the dialect rather than from the writer, so that a misunderstanding of
 * the escaping rule would have to be made twice, in two directions, to pass.
 *
 * Deliberately strict: anything that is not exactly one well-formed token is a
 * refusal, because "the database would probably cope" is the assumption these
 * tests exist to remove.
 */

export interface ScannedToken {
  readonly kind: 'literal' | 'identifier' | 'number' | 'keyword';
  /** The text a database would understand the token to mean. */
  readonly text: string;
  /** Where the token ends, so a caller can insist nothing follows it. */
  readonly end: number;
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/u;
const KEYWORD = /^[A-Za-z_][A-Za-z0-9_]*/u;

/** Reads a quoted run, returning its text with doubled quotes collapsed. */
const readQuoted = (sql: string, start: number, quote: string): ScannedToken | null => {
  let text = '';
  let index = start + 1;
  for (;;) {
    if (index >= sql.length) return null; // unterminated
    const char = sql[index] as string;
    if (char !== quote) {
      text += char;
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      text += quote;
      index += 2;
      continue;
    }
    return {
      kind: quote === "'" ? 'literal' : 'identifier',
      text,
      end: index + 1,
    };
  }
};

/** One token at `from`, or `null` where nothing well-formed begins there. */
export const scanToken = (sql: string, from = 0): ScannedToken | null => {
  const char = sql[from];
  if (char === undefined) return null;
  if (char === "'" || char === '"') return readQuoted(sql, from, char);
  const number = NUMBER.exec(sql.slice(from));
  if (number !== null) {
    const text = number[0];
    return { kind: 'number', text, end: from + text.length };
  }
  const keyword = KEYWORD.exec(sql.slice(from));
  if (keyword !== null) {
    const text = keyword[0];
    return { kind: 'keyword', text, end: from + text.length };
  }
  return null;
};

/** The token a whole string is, or `null` if it is not exactly one. */
export const scanWhole = (sql: string): ScannedToken | null => {
  const token = scanToken(sql, 0);
  return token === null || token.end !== sql.length ? null : token;
};

/**
 * Every quoted run in a statement, so a test can ask what the statement's
 * literals actually say — and whether an injected quote closed one early.
 */
export const scanQuoted = (sql: string): readonly ScannedToken[] => {
  const found: ScannedToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char !== "'" && char !== '"') {
      index += 1;
      continue;
    }
    const token = readQuoted(sql, index, char);
    if (token === null) {
      // An unterminated run swallows the rest, which is what a database would do
      // with it too. Reported as such rather than skipped.
      found.push({
        kind: char === "'" ? 'literal' : 'identifier',
        text: sql.slice(index + 1),
        end: sql.length,
      });
      return found;
    }
    found.push(token);
    index = token.end;
  }
  return found;
};

/**
 * The statement with every quoted run replaced by a single space.
 *
 * What is left is the statement's *structure*: keywords, punctuation and bare
 * numbers. A value that escaped its quotes would show up here as syntax, which
 * is the whole question.
 */
export const withoutQuoted = (sql: string): string => {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (char !== "'" && char !== '"') {
      out += char;
      index += 1;
      continue;
    }
    const token = readQuoted(sql, index, char);
    if (token === null) return `${out} `;
    out += ' ';
    index = token.end;
  }
  return out;
};
