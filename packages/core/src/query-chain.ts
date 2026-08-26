import type { Entity, QuerySource, RelationSource, TableEntity } from './entities.js';
import { derivedFromOf, isQueryTable, isTableEntity } from './entities.js';
import type { EntityId } from './ids.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';
import type { WorldState } from './world.js';

/**
 * Chains of queries, and the name a query calls its input by.
 *
 * A query box refines one table. Written out in full, a refinement of a
 * refinement of a table is a statement wrapped in a statement wrapped in a
 * table name — and by the third level nobody can see what their own `WHERE`
 * clause is doing. So a box says `FROM derived_table` and means "whatever I was
 * opened on", and the levels are put together into one statement at the moment
 * it is run.
 *
 * That indirection is not only for legibility. Because a box stores its own step
 * and a reference rather than a copy of everything before it, changing an early
 * step changes what every later step reads — so refining a filter refreshes the
 * tables built on top of it instead of leaving them showing rows that no longer
 * come from anywhere.
 */

/** What a query box calls the table it refines. Not a real relation anywhere. */
export const DERIVED_TABLE = 'derived_table';

/** Half-open character range within a statement. */
export interface SqlRange {
  readonly from: number;
  readonly to: number;
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/u;

/** True where an identifier may begin or end: the ends of the text count. */
const isBoundary = (sql: string, index: number): boolean => {
  const char = sql[index];
  return char === undefined || !IDENTIFIER_CHAR.test(char);
};

/**
 * Skips a quoted run, from its opening quote to past its closing one.
 *
 * A doubled quote is SQL's escape rather than the end, and an unterminated
 * literal swallows the rest of the statement — which is what the database will
 * say about it too.
 */
const skipQuoted = (sql: string, start: number, quote: string): number => {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
};

/**
 * Every place a statement uses an identifier.
 *
 * Lexed rather than matched, so the name is found where it is a reference and
 * left alone where it is text: `WHERE label = 'derived_table'` is a comparison
 * against a string, and a comment mentioning the name is a comment. Matched
 * without regard to case, because an unquoted identifier is.
 */
export const identifierRanges = (sql: string, name: string): readonly SqlRange[] => {
  // No name is nowhere. Said here rather than left to the scan: a zero-length
  // name matches at every position without consuming anything, so the walk below
  // would report an empty range at each index and never reach the end of the
  // string. Nothing in the application asks this — the one name it looks for is
  // a constant — but an exported function that hangs on the empty string is a
  // trap for the next caller.
  if (name === '') return [];
  const ranges: SqlRange[] = [];
  const lower = sql.toLowerCase();
  const wanted = name.toLowerCase();
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      index = skipQuoted(sql, index, char);
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    const end = index + wanted.length;
    if (lower.startsWith(wanted, index) && isBoundary(sql, index - 1) && isBoundary(sql, end)) {
      ranges.push({ from: index, to: end });
      index = end;
      continue;
    }
    index += 1;
  }
  return ranges;
};

export const derivedTableRanges = (sql: string): readonly SqlRange[] =>
  identifierRanges(sql, DERIVED_TABLE);

/**
 * Renames the input, wherever the statement refers to it.
 *
 * An identifier is swapped for an identifier, so it stays valid in every
 * position a table reference can appear — `FROM derived_table`,
 * `derived_table.COUNTRY`, `derived_table AS d`, a join, twice. Which is exactly
 * why the levels are joined by naming rather than by nesting each statement
 * inside the next.
 */
export const replaceDerivedTable = (sql: string, replacement: string): string => {
  let out = '';
  let last = 0;
  for (const range of derivedTableRanges(sql)) {
    out += sql.slice(last, range.from) + replacement;
    last = range.to;
  }
  return out + sql.slice(last);
};

export type QueryChainErrorCode = 'not-a-query' | 'missing-base' | 'cycle';

export interface QueryChainError {
  readonly code: QueryChainErrorCode;
  readonly message: string;
}

const relationOf = (entity: TableEntity): RelationSource | undefined =>
  entity.source.kind === 'relation' ? entity.source : undefined;

/** One step of a chain: a table whose rows come from a statement. */
export type QueryStep = TableEntity & { readonly source: QuerySource };

export interface QueryChain {
  /**
   * The stored relation the chain reads from, where it reads from one. Absent
   * for a query with nothing behind it, whose own statement is the beginning.
   */
  readonly relation: RelationSource | undefined;
  /** Refinements in the order they were built, ending with the one asked for. */
  readonly steps: readonly QueryStep[];
}

/**
 * The steps a query is built from, the earliest first.
 *
 * A chain is a chain by construction — a box is opened on a table that already
 * exists — but a document can be written by anything, so a loop is reported
 * rather than followed forever. A step whose table has been closed is reported
 * too: the statement cannot be put together without it, and saying so is better
 * than running something that reads the wrong rows.
 */
export const derivedChain = (
  world: WorldState,
  tableId: EntityId,
): Result<QueryChain, QueryChainError> => {
  const entity = world.entities.get(tableId);
  if (entity === undefined || !isTableEntity(entity) || !isQueryTable(entity)) {
    return err({ code: 'not-a-query', message: `No query table with id ${tableId}` });
  }
  const steps: QueryStep[] = [entity];
  const seen = new Set<EntityId>([tableId]);
  let current: QueryStep = entity;
  for (;;) {
    const baseId = current.source.derivedFrom;
    if (baseId === undefined) return ok({ relation: undefined, steps: steps.reverse() });
    if (seen.has(baseId)) {
      return err({ code: 'cycle', message: `The query chain through ${baseId} refines itself` });
    }
    seen.add(baseId);
    const base: Entity | undefined = world.entities.get(baseId);
    if (base === undefined || !isTableEntity(base)) {
      return err({
        code: 'missing-base',
        message: 'The table this query refines is no longer open',
      });
    }
    const relation = relationOf(base);
    if (relation !== undefined) return ok({ relation, steps: steps.reverse() });
    // A source is a relation or a query, and the relation case has just
    // returned; this is the narrowing that says so.
    const step = base as QueryStep;
    steps.push(step);
    current = step;
  }
};

/**
 * Everything built directly on this table: query boxes and charts alike.
 *
 * The same relationship, so the same list. Whatever follows the chain — closing
 * it, refreshing it, drawing the line — should not have to know which kind it is
 * looking at.
 */
export const derivedTablesOf = (world: WorldState, tableId: EntityId): readonly TableEntity[] =>
  [...world.entities.values()].filter(
    (entity): entity is TableEntity => isTableEntity(entity) && derivedFromOf(entity) === tableId,
  );

/**
 * Everything built on this table, directly or through others, each after the one
 * it was built on — so re-running them in order runs a parent before its
 * children.
 */
export const derivedTreeOf = (world: WorldState, tableId: EntityId): readonly TableEntity[] => {
  const found: TableEntity[] = [];
  const queue: EntityId[] = [tableId];
  const seen = new Set<EntityId>(queue);
  while (queue.length > 0) {
    for (const child of derivedTablesOf(world, queue.shift() as EntityId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child);
      queue.push(child.id);
    }
  }
  return found;
};

/** Name one step of a chain takes when it becomes a common table expression. */
export const derivedStepName = (step: number): string => `${DERIVED_TABLE}_${step}`;

const indent = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `  ${line}`))
    .join('\n');

const withExpressions = (
  expressions: readonly string[],
  statement: string,
  recursive = false,
): string =>
  expressions.length === 0
    ? statement
    : `WITH ${recursive ? 'RECURSIVE ' : ''}${expressions.join(',\n')}\n${statement}`;

/** Where the next non-space, non-comment character is. */
const skipBlank = (sql: string, from: number): number => {
  let index = from;
  while (index < sql.length) {
    const char = sql[index] as string;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    return index;
  }
  return sql.length;
};

/** True where a keyword stands on its own at this position, whatever its case. */
const keywordAt = (sql: string, index: number, keyword: string): boolean =>
  sql.slice(index, index + keyword.length).toLowerCase() === keyword.toLowerCase() &&
  isBoundary(sql, index - 1) &&
  isBoundary(sql, index + keyword.length);

/** Past a balanced parenthesis group, quotes and comments and all. */
const skipParens = (sql: string, open: number): number => {
  let depth = 0;
  let index = open;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      index = skipQuoted(sql, index, char);
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
};

/**
 * A statement's own `WITH` clause, taken apart.
 *
 * Needed because a chain composes into one statement, and a step that begins
 * with its own `WITH` cannot simply be concatenated after ours: `WITH a AS (…)
 * WITH b AS (…) SELECT` is two clauses in a row, which is not a statement. It
 * parsed on one database by luck and would not survive a stricter one, a
 * different dialect, or a name collision.
 *
 * So the clause is found and its bindings are merged into ours, which is what
 * somebody writing the statement by hand would have done. Read by walking the
 * shape of the clause — a name, an optional column list, `AS`, a balanced group,
 * a comma or the end of it — rather than by matching, because a `SELECT` inside a
 * common table expression looks exactly like the one that follows the clause.
 *
 * `null` where there is no clause to take apart, or where it is not shaped like
 * one: the caller then has a fallback that is always valid, and guessing would be
 * worse than either.
 */
export interface WithClause {
  readonly recursive: boolean;
  /** The bindings, as written, without the `WITH` keyword. */
  readonly bindings: string;
  /** The query the clause was in front of. */
  readonly rest: string;
}

export const splitWithClause = (sql: string): WithClause | null => {
  let index = skipBlank(sql, 0);
  if (!keywordAt(sql, index, 'with')) return null;
  index = skipBlank(sql, index + 'with'.length);
  const recursive = keywordAt(sql, index, 'recursive');
  if (recursive) index = skipBlank(sql, index + 'recursive'.length);
  const start = index;
  for (;;) {
    // A name, then an optional column list, then AS, then the body.
    const nameEnd = (() => {
      let at = index;
      while (at < sql.length && IDENTIFIER_CHAR.test(sql[at] as string)) at += 1;
      return at;
    })();
    if (sql[index] === '"') {
      const quoted = skipQuoted(sql, index, '"');
      index = skipBlank(sql, quoted);
    } else {
      if (nameEnd === index) return null;
      index = skipBlank(sql, nameEnd);
    }
    if (sql[index] === '(') {
      const columns = skipParens(sql, index);
      if (columns < 0) return null;
      index = skipBlank(sql, columns);
    }
    if (!keywordAt(sql, index, 'as')) return null;
    index = skipBlank(sql, index + 'as'.length);
    if (sql[index] !== '(') return null;
    const body = skipParens(sql, index);
    if (body < 0) return null;
    const after = skipBlank(sql, body);
    if (sql[after] !== ',') {
      return {
        recursive,
        bindings: sql.slice(start, body).trim(),
        rest: sql.slice(after).trim(),
      };
    }
    index = skipBlank(sql, after + 1);
  }
};

/**
 * Joins a chain into one statement.
 *
 * Every step but the last becomes a named common table expression and the last
 * becomes the outer query, so the composed statement reads in the order the user
 * built it rather than inside-out. A chain reading a stored relation needs no
 * expression for it — the table has a real name, so a single query on a table
 * composes to exactly the statement the user wrote and nothing more.
 *
 * Naming rather than nesting is what keeps the substitution safe: an identifier
 * replaces an identifier, so it stays valid wherever a table reference can go —
 * which is also why `relationName` must render a stored relation as its *name*,
 * quoted for the dialect, rather than as a statement selecting from it.
 */
export const composeQuery = (
  world: WorldState,
  tableId: EntityId,
  relationName: (source: RelationSource) => string,
): Result<string, QueryChainError> => {
  const chain = derivedChain(world, tableId);
  if (!chain.ok) return chain;
  const { relation, steps } = chain.value;
  const expressions: string[] = [];
  let input: string | null = relation === undefined ? null : relationName(relation);

  const resolve = (step: QueryStep): string =>
    input === null ? step.source.sql : replaceDerivedTable(step.source.sql, input);

  /**
   * A name for this step that no step has used for anything else.
   *
   * A statement is free to bind `derived_table_1` itself, and two bindings of one
   * name in a clause is an error at best and the wrong table at worst. So the
   * generated names give way to the written ones.
   */
  const taken = steps.map((step) => step.source.sql);
  const freeName = (step: number): string => {
    let name = derivedStepName(step);
    while (taken.some((sql) => identifierRanges(sql, name).length > 0)) name = `${name}_x`;
    return name;
  };

  for (const step of steps.slice(0, -1)) {
    const name = freeName(expressions.length + 1);
    expressions.push(`${name} AS (\n${indent(resolve(step))}\n)`);
    input = name;
  }

  const outer = resolve(steps[steps.length - 1] as QueryStep);
  if (expressions.length === 0) return ok(outer);
  // The last step's own clause, merged into ours rather than written after it.
  const own = splitWithClause(outer);
  if (own === null) return ok(withExpressions(expressions, outer));
  return ok(withExpressions([...expressions, own.bindings], own.rest, own.recursive));
};
