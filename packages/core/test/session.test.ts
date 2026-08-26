import { describe, expect, it } from 'vitest';
import type { BindingId, ChartMarkTarget, EntityId, SessionState } from '@panorama/core';
import {
  applySessionCommand,
  hoveredMarkOf,
  selectedMarksOf,
  emptySession,
  activatedEntity,
  isActionHovered,
  isBindingRevealed,
  isActionPressed,
  isColumnSelected,
  isDragging,
  isEntityActivated,
  isSelected,
} from '@panorama/core';

const a = 'table:a' as EntityId;
const b = 'table:b' as EntityId;

describe('selected columns', () => {
  const first = 'column:1' as EntityId;
  const second = 'column:2' as EntityId;

  it('records what was picked out, and says so', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetSelectedColumns',
      ids: [first, second],
    });
    expect(state.selectedColumns).toEqual([first, second]);
    expect(isColumnSelected(state, first)).toBe(true);
    expect(isColumnSelected(state, 'column:3' as EntityId)).toBe(false);
  });

  it('copies the list rather than keeping the caller own', () => {
    const ids = [first];
    const state = applySessionCommand(emptySession(), { type: 'SetSelectedColumns', ids });
    ids.push(second);
    expect(state.selectedColumns).toEqual([first]);
  });

  it('returns the same state when nothing changed, so subscribers can skip', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetSelectedColumns',
      ids: [first],
    });
    expect(applySessionCommand(state, { type: 'SetSelectedColumns', ids: [first] })).toBe(state);
    expect(applySessionCommand(state, { type: 'SetSelectedColumns', ids: [] })).not.toBe(state);
  });

  it('is untouched by picking a different table, or by hovering', () => {
    const picked = applySessionCommand(emptySession(), {
      type: 'SetSelectedColumns',
      ids: [first],
    });
    const elsewhere = applySessionCommand(picked, { type: 'SetSelection', ids: [b] });
    expect(elsewhere.selectedColumns).toEqual([first]);
    expect(applySessionCommand(elsewhere, { type: 'SetHovered', id: a }).selectedColumns).toEqual([
      first,
    ]);
  });
});

describe('session state', () => {
  it('starts empty', () => {
    const state = emptySession();
    expect(state).toEqual({
      selection: [],
      focusedTable: null,
      hovered: null,
      drag: null,
      pointer: null,
      selectedColumns: [],
      hoveredMark: null,
      selectedMarks: [],
      hoveredAction: null,
      pressedAction: null,
      expandedAction: null,
      hoveredBinding: null,
      pressedBinding: null,
    });
    expect(isDragging(state)).toBe(false);
    expect(isSelected(state, a)).toBe(false);
  });

  it('focuses the table when exactly one entity is selected', () => {
    const state = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [a] });
    expect(state.selection).toEqual([a]);
    expect(state.focusedTable).toBe(a);
    expect(isSelected(state, a)).toBe(true);
  });

  it('clears focus for multi-selection', () => {
    const state = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [a, b] });
    expect(state.focusedTable).toBeNull();
  });

  it('returns the same object when the selection is unchanged', () => {
    const first = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [a] });
    expect(applySessionCommand(first, { type: 'SetSelection', ids: [a] })).toBe(first);
    expect(applySessionCommand(first, { type: 'SetSelection', ids: [b] })).not.toBe(first);
    expect(applySessionCommand(first, { type: 'SetSelection', ids: [a, b] })).not.toBe(first);
  });

  it('tracks hover', () => {
    const hovered = applySessionCommand(emptySession(), { type: 'SetHovered', id: a });
    expect(hovered.hovered).toBe(a);
    expect(applySessionCommand(hovered, { type: 'SetHovered', id: a })).toBe(hovered);
    expect(applySessionCommand(hovered, { type: 'SetHovered', id: null }).hovered).toBeNull();
  });

  it('tracks the focused table independently of selection', () => {
    const focused = applySessionCommand(emptySession(), { type: 'SetFocusedTable', id: b });
    expect(focused.focusedTable).toBe(b);
    expect(focused.selection).toEqual([]);
    expect(applySessionCommand(focused, { type: 'SetFocusedTable', id: b })).toBe(focused);
  });

  it('begins and ends drags', () => {
    const dragging = applySessionCommand(emptySession(), {
      type: 'BeginDrag',
      drag: {
        kind: 'move-entity',
        entityId: a,
        pointerStart: { x: 0, y: 0, z: 0 },
        entityStart: { x: 0, y: 0, z: 0 },
      },
    });
    expect(isDragging(dragging)).toBe(true);
    const ended = applySessionCommand(dragging, { type: 'EndDrag' });
    expect(ended.drag).toBeNull();
    expect(applySessionCommand(ended, { type: 'EndDrag' })).toBe(ended);
  });

  it('tracks the pointer', () => {
    const pointer = { world: { x: 3, y: 4, z: 0 }, screenX: 30, screenY: 40 };
    const state: SessionState = applySessionCommand(emptySession(), {
      type: 'SetPointer',
      pointer,
    });
    expect(state.pointer).toEqual(pointer);
    expect(applySessionCommand(state, { type: 'SetPointer', pointer: null }).pointer).toBeNull();
  });
});

describe('entity actions', () => {
  const closeA = { entityId: a, action: 'close' } as const;

  it('tracks the hovered action', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetHoveredAction',
      target: closeA,
    });
    expect(state.hoveredAction).toEqual(closeA);
    expect(isActionHovered(state, closeA)).toBe(true);
    expect(isActionHovered(state, { entityId: b, action: 'close' })).toBe(false);
  });

  it('tracks the pressed action', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetPressedAction',
      target: closeA,
    });
    expect(isActionPressed(state, closeA)).toBe(true);
    expect(isActionPressed(emptySession(), closeA)).toBe(false);
  });

  it('returns the same object for an equivalent target', () => {
    const first = applySessionCommand(emptySession(), {
      type: 'SetHoveredAction',
      target: closeA,
    });
    expect(
      applySessionCommand(first, {
        type: 'SetHoveredAction',
        target: { entityId: a, action: 'close' },
      }),
    ).toBe(first);
    expect(applySessionCommand(first, { type: 'SetHoveredAction', target: null })).not.toBe(first);

    const pressed = applySessionCommand(emptySession(), {
      type: 'SetPressedAction',
      target: closeA,
    });
    expect(applySessionCommand(pressed, { type: 'SetPressedAction', target: { ...closeA } })).toBe(
      pressed,
    );
    expect(applySessionCommand(pressed, { type: 'SetPressedAction', target: null })).not.toBe(
      pressed,
    );
  });

  it('distinguishes a different entity and a null target', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetHoveredAction',
      target: closeA,
    });
    expect(
      applySessionCommand(state, {
        type: 'SetHoveredAction',
        target: { entityId: b, action: 'close' },
      }).hoveredAction,
    ).toEqual({ entityId: b, action: 'close' });
  });
});

describe('activation', () => {
  it('activates nothing by default', () => {
    expect(activatedEntity(emptySession())).toBeNull();
    expect(isEntityActivated(emptySession(), a)).toBe(false);
  });

  it('activates the hovered entity', () => {
    const hovered = applySessionCommand(emptySession(), { type: 'SetHovered', id: a });
    expect(activatedEntity(hovered)).toBe(a);
    expect(isEntityActivated(hovered, b)).toBe(false);
  });

  it('activates the focused entity when nothing is hovered', () => {
    const selected = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [b] });
    expect(activatedEntity(selected)).toBe(b);
  });

  it('activates exactly one entity: hover wins over selection', () => {
    // Selecting one table and hovering another must not activate both, or the
    // action halo would trail behind the pointer.
    const selected = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [a] });
    const hoveringOther = applySessionCommand(selected, { type: 'SetHovered', id: b });

    expect(activatedEntity(hoveringOther)).toBe(b);
    expect(isEntityActivated(hoveringOther, a)).toBe(false);
    expect(isEntityActivated(hoveringOther, b)).toBe(true);
  });

  it('returns to the focused entity once the pointer leaves', () => {
    let state = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [a] });
    state = applySessionCommand(state, { type: 'SetHovered', id: b });
    state = applySessionCommand(state, { type: 'SetHovered', id: null });
    expect(activatedEntity(state)).toBe(a);
  });

  it('activates nothing for a multi-selection', () => {
    const many = applySessionCommand(emptySession(), { type: 'SetSelection', ids: [a, b] });
    expect(many.focusedTable).toBeNull();
    expect(activatedEntity(many)).toBeNull();
  });
});

describe('binding markers', () => {
  const first = 'binding:1' as BindingId;
  const second = 'binding:2' as BindingId;

  it('reveals a binding on hover and on press', () => {
    const hovered = applySessionCommand(emptySession(), {
      type: 'SetHoveredBinding',
      id: first,
    });
    expect(isBindingRevealed(hovered, first)).toBe(true);
    expect(isBindingRevealed(hovered, second)).toBe(false);

    // Press reveals too, which is how a touch shows what a hover would.
    const pressed = applySessionCommand(emptySession(), {
      type: 'SetPressedBinding',
      id: first,
    });
    expect(isBindingRevealed(pressed, first)).toBe(true);
    expect(isBindingRevealed(emptySession(), first)).toBe(false);
  });

  it('returns the same object when nothing changed', () => {
    const state = applySessionCommand(emptySession(), { type: 'SetHoveredBinding', id: first });
    expect(applySessionCommand(state, { type: 'SetHoveredBinding', id: first })).toBe(state);
    expect(applySessionCommand(state, { type: 'SetHoveredBinding', id: null })).not.toBe(state);

    const pressed = applySessionCommand(emptySession(), { type: 'SetPressedBinding', id: first });
    expect(applySessionCommand(pressed, { type: 'SetPressedBinding', id: first })).toBe(pressed);
    expect(applySessionCommand(pressed, { type: 'SetPressedBinding', id: null })).not.toBe(pressed);
  });
});

describe('pointing at a chart, and picking parts of it out', () => {
  const mark = (entityId: EntityId, series: number, data: number): ChartMarkTarget => ({
    entityId,
    series,
    data,
  });

  it('remembers the mark under the pointer', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetHoveredMark',
      target: mark(a, 0, 2),
    });
    expect(state.hoveredMark).toEqual({ entityId: a, series: 0, data: 2 });
    expect(hoveredMarkOf(state, a)).toEqual({ entityId: a, series: 0, data: 2 });
    // Only in the chart the pointer is actually in.
    expect(hoveredMarkOf(state, b)).toBeNull();
  });

  it('does not churn when the pointer stays on the same mark', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetHoveredMark',
      target: mark(a, 0, 2),
    });
    expect(applySessionCommand(state, { type: 'SetHoveredMark', target: mark(a, 0, 2) })).toBe(
      state,
    );
    expect(applySessionCommand(state, { type: 'SetHoveredMark', target: mark(a, 0, 3) })).not.toBe(
      state,
    );
    expect(applySessionCommand(emptySession(), { type: 'SetHoveredMark', target: null })).toEqual(
      emptySession(),
    );
  });

  it('keeps the marks picked out, per chart', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetSelectedMarks',
      targets: [mark(a, 0, 1), mark(b, 1, 4)],
    });
    expect(selectedMarksOf(state, a)).toEqual([{ entityId: a, series: 0, data: 1 }]);
    expect(selectedMarksOf(state, b)).toEqual([{ entityId: b, series: 1, data: 4 }]);
  });

  it('does not churn when the same marks are set again', () => {
    const targets = [mark(a, 0, 1)];
    const state = applySessionCommand(emptySession(), { type: 'SetSelectedMarks', targets });
    expect(applySessionCommand(state, { type: 'SetSelectedMarks', targets: [...targets] })).toBe(
      state,
    );
    expect(
      applySessionCommand(state, { type: 'SetSelectedMarks', targets: [mark(a, 0, 2)] }),
    ).not.toBe(state);
    expect(applySessionCommand(state, { type: 'SetSelectedMarks', targets: [] })).not.toBe(state);
  });

  it('lets go of them all', () => {
    const state = applySessionCommand(emptySession(), {
      type: 'SetSelectedMarks',
      targets: [mark(a, 0, 1)],
    });
    const cleared = applySessionCommand(state, { type: 'SetSelectedMarks', targets: [] });
    expect(selectedMarksOf(cleared, a)).toEqual([]);
  });
});
