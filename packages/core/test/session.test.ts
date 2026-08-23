import { describe, expect, it } from 'vitest';
import type { EntityId, SessionState } from '@panorama/core';
import {
  applySessionCommand,
  emptySession,
  activatedEntity,
  isActionHovered,
  isActionPressed,
  isDragging,
  isEntityActivated,
  isSelected,
} from '@panorama/core';

const a = 'table:a' as EntityId;
const b = 'table:b' as EntityId;

describe('session state', () => {
  it('starts empty', () => {
    const state = emptySession();
    expect(state).toEqual({
      selection: [],
      focusedTable: null,
      hovered: null,
      drag: null,
      pointer: null,
      hoveredAction: null,
      pressedAction: null,
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
