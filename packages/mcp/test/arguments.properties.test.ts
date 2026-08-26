import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Command, EntityId } from '@panorama/core';
import { applyCommand, applySessionCommand, emptySession } from '@panorama/core';
import type { ArgsSpec, FieldKind, FieldSpec } from '@panorama/mcp';
import {
  AGENT_TOOLS,
  AgentError,
  COMMAND_FIELDS,
  jsonSchema,
  readArgs,
  readCommand,
  readSessionCommand,
} from '@panorama/mcp';
import { accepts } from './json-schema-check.js';
import { CHART_SPEC, makeTable, testIds } from './fixtures.js';

/**
 * Properties of the boundary an agent arrives at.
 *
 * This is the one caller that reaches the document with no keyboard and no
 * pointer in the way, and everything it sends is JSON that has been through a
 * pipe. Two things have to be true for every message anyone can send, not just
 * the ones the example tests name: a refusal must come back as a refusal rather
 * than as a crash, and the schema an agent reads must describe the check it will
 * actually be judged by.
 *
 * Seeds are pinned. A property test drawing fresh inputs on every run would
 * reach different lines every run — which the 100 % line gate would report as a
 * moving number — and a counterexample nobody can replay is one nobody can fix.
 */

const RUNS = { numRuns: 300 } as const;

/** Keys chosen to go wrong: the ones that mean something to an object. */
const HOSTILE_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', ''] as const;

/** JSON as it arrives: no undefined, no functions, but every shape and depth. */
const jsonValue = fc.jsonValue({ maxDepth: 3 });

/** An object whose keys include the ones that mean something to an object. */
const hostileObject = fc.dictionary(
  fc.oneof(fc.constantFrom(...HOSTILE_KEYS), fc.string({ maxLength: 6 })),
  jsonValue,
  { maxKeys: 4 },
);

/** Anything an argument bag could turn out to be. */
const argumentBag = fc.oneof(
  jsonValue,
  hostileObject,
  fc.constant(undefined),
  fc.constant(null),
  fc.dictionary(fc.string({ maxLength: 4 }), fc.constant(Number.NaN), { maxKeys: 2 }),
);

/** Every tool's arguments, by name, so a failure says which tool it was. */
const TOOLS = AGENT_TOOLS.map((tool): readonly [string, ArgsSpec] => [tool.name, tool.args]);

/** A tool argument list with no nested schema; see the agreement property. */
const isShallow = (spec: ArgsSpec): boolean =>
  Object.values(spec).every((field) => field.schema === undefined);

describe('reading arguments is total', () => {
  it('answers every tool with a value or a refusal, never a crash', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOOLS), argumentBag, ([name, spec], args) => {
        try {
          readArgs(spec, args);
        } catch (error) {
          // The one permitted failure: something the sender can read and act on.
          // A TypeError here is a stack trace an agent cannot do anything with,
          // and — where this runs in the page — a crash in the tab.
          expect(error, `${name} threw something that is not a refusal`).toBeInstanceOf(AgentError);
          expect((error as AgentError).message).not.toBe('');
        }
      }),
      { seed: 20260826, ...RUNS },
    );
  });

  it('leaves no mark on the objects everything else is made of', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOOLS), hostileObject, ([, spec], args) => {
        try {
          readArgs(spec, args);
        } catch {
          // Refusals are the subject of the property above.
        }
        // A bag with `__proto__` in it must not have reached anything's
        // prototype on the way through.
        const bare = {} as Record<string, unknown>;
        expect(bare['polluted']).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
      }),
      { seed: 301, numRuns: 200 },
    );
  });
});

describe('the schema an agent reads and the check it is judged by', () => {
  /** Values likely to sit on the boundary of a field's kind. */
  const fieldValue = (field: FieldSpec): fc.Arbitrary<unknown> => {
    const enumerated = field.enum;
    const candidates: fc.Arbitrary<unknown>[] = [
      jsonValue,
      fc.string({ maxLength: 5 }),
      fc.integer({ min: -3, max: 3 }),
      fc.double({ min: -3, max: 3, noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.array(fc.string({ maxLength: 3 }), { maxLength: 3 }),
      fc.array(fc.record({ a: fc.integer() }), { maxLength: 2 }),
      fc.record({ x: fc.integer(), y: fc.integer() }),
      fc.record({ x: fc.integer(), y: fc.integer(), z: fc.integer() }),
      fc.record({ entityId: fc.string({ maxLength: 3 }), series: fc.nat(3), data: fc.nat(3) }),
      fc.array(
        fc.record({ entityId: fc.string({ maxLength: 3 }), series: fc.nat(3), data: fc.nat(3) }),
        { maxLength: 2 },
      ),
      fc.constant(null),
    ];
    if (enumerated !== undefined) candidates.push(fc.constantFrom(...enumerated));
    return fc.oneof(...candidates);
  };

  const argumentsFor = (spec: ArgsSpec): fc.Arbitrary<Record<string, unknown>> => {
    const names = Object.keys(spec);
    if (names.length === 0) return fc.constant({});
    return fc.tuple(...names.map((name) => fieldValue(spec[name] as FieldSpec))).map((values) => {
      const bag: Record<string, unknown> = {};
      names.forEach((name, index) => {
        const value = values[index];
        // Some of the time a field is simply left out, which is the case the two
        // halves are likeliest to disagree about.
        if (value !== undefined) bag[name] = value;
      });
      return bag;
    });
  };

  it('accept exactly the same arguments', () => {
    const shallow = TOOLS.filter(([, spec]) => isShallow(spec));
    expect(shallow.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(
        fc
          .constantFrom(...shallow)
          .chain(([name, spec]) => argumentsFor(spec).map((args) => ({ name, spec, args }))),
        ({ name, spec, args }) => {
          // A null is "not given" to the runtime check, and JSON Schema has no
          // way of saying that, so the comparison is against the bag as the check
          // understands it. Everything else must match exactly.
          const withoutNulls = Object.fromEntries(
            Object.entries(args).filter(([, value]) => value !== null),
          );
          const bySchema = accepts(jsonSchema(spec), withoutNulls);
          let byCheck = true;
          try {
            readArgs(spec, args);
          } catch (error) {
            expect(error).toBeInstanceOf(AgentError);
            byCheck = false;
          }
          expect(
            byCheck,
            `${name} disagrees with its own schema about ${JSON.stringify(args)}`,
          ).toBe(bySchema);
        },
      ),
      { seed: 302, numRuns: 500 },
    );
  });

  it('never refuse arguments the schema promised would do', () => {
    // Where a field carries a schema of its own, the runtime check stays shallow
    // on purpose and the reader for that shape does the rest. So the claim is
    // one-directional: nothing the schema accepts may be refused for its shape.
    const deep = TOOLS.filter(([, spec]) => !isShallow(spec));
    fc.assert(
      fc.property(
        fc
          .constantFrom(...deep)
          .chain(([name, spec]) => argumentsFor(spec).map((args) => ({ name, spec, args }))),
        ({ name, spec, args }) => {
          if (!accepts(jsonSchema(spec), args)) return;
          expect(() => readArgs(spec, args), `${name} refused what it advertised`).not.toThrow();
        },
      ),
      { seed: 303, numRuns: 300 },
    );
  });
});

describe('reading a command', () => {
  const COMMANDS = Object.entries(COMMAND_FIELDS);

  /** A binding an agent could legitimately ask for. */
  const validBinding = fc.record({
    id: fc.string({ minLength: 1, maxLength: 6 }).map((text) => `binding:${text}`),
    fromId: fc.string({ minLength: 1, maxLength: 4 }),
    toId: fc.string({ minLength: 1, maxLength: 4 }),
    directed: fc.boolean(),
  });

  /** A value of the right kind for a field, so the command is a valid one. */
  const validValue = (name: string, field: FieldSpec): fc.Arbitrary<unknown> => {
    const kinds: Readonly<Record<FieldKind, fc.Arbitrary<unknown>>> = {
      string: fc.string({ minLength: 1, maxLength: 8 }),
      number: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
      integer: fc.integer({ min: -100, max: 100 }),
      boolean: fc.boolean(),
      object: name === 'binding' ? validBinding : fc.constant({ ...CHART_SPEC }),
      'string-array': fc.array(fc.string({ minLength: 1, maxLength: 5 }), { maxLength: 3 }),
      vec3: fc.record({ x: fc.integer(), y: fc.integer(), z: fc.integer() }),
      'mark-array': fc.array(
        fc.record({
          entityId: fc.string({ minLength: 1, maxLength: 3 }),
          series: fc.nat(2),
          data: fc.nat(2),
        }),
        { minLength: 1, maxLength: 2 },
      ),
      'object-array': fc.array(fc.record({ a: fc.integer() }), { minLength: 1, maxLength: 2 }),
    };
    if (field.enum !== undefined) return fc.constantFrom(...field.enum);
    return kinds[field.kind];
  };

  const commandOf = (type: string, spec: ArgsSpec): fc.Arbitrary<Record<string, unknown>> => {
    const names = Object.keys(spec);
    return fc
      .tuple(...names.map((name) => validValue(name, spec[name] as FieldSpec)))
      .map((values) => {
        const sent: Record<string, unknown> = { type };
        names.forEach((name, index) => {
          sent[name] = values[index];
        });
        return sent;
      });
  };

  it('survives the pipe: what an agent sends is what the core receives', () => {
    fc.assert(
      fc.property(
        fc
          .constantFrom(...COMMANDS)
          .chain(([type, spec]) => commandOf(type, spec).map((sent) => ({ type, sent }))),
        ({ type, sent }) => {
          const command = readCommand(sent);
          expect(command.type).toBe(type);
          // Through JSON and back: the field names on both sides of the pipe have
          // to be the same names, which is the drift that once crashed the page.
          const again = readCommand(JSON.parse(JSON.stringify(command)) as Record<string, unknown>);
          expect(again).toEqual(command);
        },
      ),
      { seed: 304, numRuns: 400 },
    );
  });

  it('refuses anything else in terms the sender can act on', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          hostileObject,
          fc.record({ type: fc.string({ maxLength: 8 }) }),
          fc.record({ type: fc.constantFrom(...COMMANDS.map(([type]) => type)) }),
          fc.dictionary(fc.constantFrom('type', 'ids', 'position', 'spec'), jsonValue, {
            maxKeys: 4,
          }),
        ),
        (sent) => {
          try {
            readCommand(sent as Record<string, unknown>);
          } catch (error) {
            expect(error).toBeInstanceOf(AgentError);
          }
        },
      ),
      { seed: 305, numRuns: 400 },
    );
  });

  it('produces commands the core can apply without crashing', () => {
    const ids = testIds(9);
    const table = makeTable(ids);
    const created = applyCommand(
      { entities: new Map(), order: [], bindings: new Map() },
      { type: 'CreateTableEntity', entity: table },
    );
    expect(created.ok).toBe(true);
    const world = created.ok ? created.value : null;
    fc.assert(
      fc.property(
        fc
          .constantFrom(...COMMANDS)
          .chain(([type, spec]) => commandOf(type, spec).map((sent) => ({ type, sent }))),
        fc.boolean(),
        ({ sent }, useRealId) => {
          if (world === null) return;
          // Half the time the command names an entity that exists, so the deeper
          // paths are reached rather than everything failing at the first check.
          const aimed = useRealId
            ? Object.fromEntries(
                Object.entries(sent).map(([name, value]) => [
                  name,
                  name === 'tableId' || name === 'id'
                    ? (table.id as string)
                    : name === 'ids'
                      ? [table.id as string]
                      : value,
                ]),
              )
            : sent;
          const command = readCommand(aimed);
          // A command that passed the boundary is a command the core is entitled
          // to assume is shaped like one. It may refuse it — it may not throw.
          const applied = applyCommand(world, command as Command);
          expect(typeof applied.ok).toBe('boolean');
        },
      ),
      { seed: 306, numRuns: 400 },
    );
  });
});

describe('reading a session command', () => {
  const SESSION_TYPES = [
    'SetSelection',
    'SetHovered',
    'SetFocusedTable',
    'SetSelectedColumns',
    'SetSelectedMarks',
    'EndDrag',
  ] as const;

  it('refuses anything malformed rather than crashing', () => {
    fc.assert(
      fc.property(
        fc.oneof(hostileObject, fc.record({ type: fc.constantFrom(...SESSION_TYPES) }), jsonValue),
        (sent) => {
          try {
            readSessionCommand(sent as Record<string, unknown>);
          } catch (error) {
            expect(error).toBeInstanceOf(AgentError);
          }
        },
      ),
      { seed: 307, ...RUNS },
    );
  });

  it('never leaves a nullable field undefined, which nothing downstream compares against', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('SetHovered', 'SetFocusedTable'),
        fc.option(fc.string({ minLength: 1, maxLength: 5 }), { nil: undefined }),
        (type, id) => {
          const command = readSessionCommand(id === undefined ? { type } : { type, id });
          const state = applySessionCommand(emptySession(), command);
          const value = type === 'SetHovered' ? state.hovered : state.focusedTable;
          // Absent means nothing, and nothing means `null` — never `undefined`,
          // which everything downstream would compare against `null` and lose.
          expect(value === null || typeof value === 'string').toBe(true);
          if (id !== undefined) expect(value).toBe(id as unknown as EntityId);
        },
      ),
      { seed: 308, numRuns: 200 },
    );
  });
});
