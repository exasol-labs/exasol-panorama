import type { Vec3 } from './geometry.js';
import type { BindingId, EntityId } from './ids.js';

/**
 * Session state is temporary but semantically accessible: an agent should be
 * able to ask what is selected or what is being dragged. It is deliberately
 * kept out of the document history — selecting something is not an edit.
 */

export type ResizeHandle =
  'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface MoveEntityDrag {
  readonly kind: 'move-entity';
  readonly entityId: EntityId;
  readonly pointerStart: Vec3;
  readonly entityStart: Vec3;
}

export interface ResizeEntityDrag {
  readonly kind: 'resize-entity';
  readonly entityId: EntityId;
  readonly handle: ResizeHandle;
  readonly pointerStart: Vec3;
  readonly entityStart: Vec3;
  readonly widthStart: number;
  readonly heightStart: number;
}

export interface ResizeColumnDrag {
  readonly kind: 'resize-column';
  readonly entityId: EntityId;
  readonly columnId: EntityId;
  readonly pointerStart: Vec3;
  readonly widthStart: number;
}

export interface PanCanvasDrag {
  readonly kind: 'pan-canvas';
  readonly pointerStart: Vec3;
}

export type DragState = MoveEntityDrag | ResizeEntityDrag | ResizeColumnDrag | PanCanvasDrag;

export interface PointerState {
  /** Pointer position in world coordinates. */
  readonly world: Vec3;
  /** Pointer position in CSS pixels relative to the canvas. */
  readonly screenX: number;
  readonly screenY: number;
}

/**
 * Actions offered on an activated entity.
 *
 * Semantic, not visual: the halo the renderer draws, a keyboard shortcut and an
 * agent all name the same action.
 */
export type EntityActionId = 'close';

export interface EntityActionTarget {
  readonly entityId: EntityId;
  readonly action: EntityActionId;
}

export interface SessionState {
  readonly selection: readonly EntityId[];
  readonly focusedTable: EntityId | null;
  /**
   * The activated entity. Set by pointer hover on the desktop, and by whatever
   * stands in for hover elsewhere — touch, or an XR gaze or controller ray.
   */
  readonly hovered: EntityId | null;
  readonly drag: DragState | null;
  readonly pointer: PointerState | null;
  readonly hoveredAction: EntityActionTarget | null;
  readonly pressedAction: EntityActionTarget | null;
  /** Binding whose marker is under the pointer; its detail is revealed. */
  readonly hoveredBinding: BindingId | null;
  readonly pressedBinding: BindingId | null;
}

export const emptySession = (): SessionState => ({
  selection: [],
  focusedTable: null,
  hovered: null,
  drag: null,
  pointer: null,
  hoveredAction: null,
  pressedAction: null,
  hoveredBinding: null,
  pressedBinding: null,
});

export interface SetSelectionCommand {
  readonly type: 'SetSelection';
  readonly ids: readonly EntityId[];
}

export interface SetHoveredCommand {
  readonly type: 'SetHovered';
  readonly id: EntityId | null;
}

export interface SetFocusedTableCommand {
  readonly type: 'SetFocusedTable';
  readonly id: EntityId | null;
}

export interface BeginDragCommand {
  readonly type: 'BeginDrag';
  readonly drag: DragState;
}

export interface EndDragCommand {
  readonly type: 'EndDrag';
}

export interface SetPointerCommand {
  readonly type: 'SetPointer';
  readonly pointer: PointerState | null;
}

export interface SetHoveredActionCommand {
  readonly type: 'SetHoveredAction';
  readonly target: EntityActionTarget | null;
}

export interface SetPressedActionCommand {
  readonly type: 'SetPressedAction';
  readonly target: EntityActionTarget | null;
}

export interface SetHoveredBindingCommand {
  readonly type: 'SetHoveredBinding';
  readonly id: BindingId | null;
}

export interface SetPressedBindingCommand {
  readonly type: 'SetPressedBinding';
  readonly id: BindingId | null;
}

export type SessionCommand =
  | SetHoveredBindingCommand
  | SetPressedBindingCommand
  | SetHoveredActionCommand
  | SetPressedActionCommand
  | SetSelectionCommand
  | SetHoveredCommand
  | SetFocusedTableCommand
  | BeginDragCommand
  | EndDragCommand
  | SetPointerCommand;

const sameIds = (a: readonly EntityId[], b: readonly EntityId[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

const sameTarget = (a: EntityActionTarget | null, b: EntityActionTarget | null): boolean =>
  a === b || (a !== null && b !== null && a.entityId === b.entityId && a.action === b.action);

/**
 * Pure session reducer. Returns the identical object when nothing changed so
 * that subscribers can skip work cheaply.
 */
export const applySessionCommand = (state: SessionState, command: SessionCommand): SessionState => {
  switch (command.type) {
    case 'SetSelection': {
      if (sameIds(state.selection, command.ids)) return state;
      // Selecting exactly one table also focuses it; that is what keyboard and
      // wheel events target.
      const focusedTable = command.ids.length === 1 ? (command.ids[0] as EntityId) : null;
      return { ...state, selection: [...command.ids], focusedTable };
    }
    case 'SetHovered':
      return state.hovered === command.id ? state : { ...state, hovered: command.id };
    case 'SetFocusedTable':
      return state.focusedTable === command.id ? state : { ...state, focusedTable: command.id };
    case 'BeginDrag':
      return { ...state, drag: command.drag };
    case 'EndDrag':
      return state.drag === null ? state : { ...state, drag: null };
    case 'SetPointer':
      return { ...state, pointer: command.pointer };
    case 'SetHoveredAction':
      return sameTarget(state.hoveredAction, command.target)
        ? state
        : { ...state, hoveredAction: command.target };
    case 'SetPressedAction':
      return sameTarget(state.pressedAction, command.target)
        ? state
        : { ...state, pressedAction: command.target };
    case 'SetHoveredBinding':
      return state.hoveredBinding === command.id ? state : { ...state, hoveredBinding: command.id };
    case 'SetPressedBinding':
      return state.pressedBinding === command.id ? state : { ...state, pressedBinding: command.id };
  }
};

/**
 * True when a binding's detail should be shown. The marker is compact by
 * default — a line's business is the connection, not its predicate — and only
 * spells the predicate out when asked, by pointer or by press.
 */
export const isBindingRevealed = (state: SessionState, id: BindingId): boolean =>
  state.hoveredBinding === id || state.pressedBinding === id;

/**
 * The single activated entity, or `null`.
 *
 * Exactly one entity is activated at a time, which is what keeps one action
 * halo on screen rather than a trail of them. Hover wins when there is one;
 * otherwise the focused entity is activated, so the halo is still reachable
 * without a pointer — by touch, by keyboard, or by an XR ray — and does not
 * vanish mid-click when the pointer leaves the table's edge.
 *
 * `focusedTable` rather than the whole selection: a multi-selection has no
 * single subject for single-entity actions.
 */
export const activatedEntity = (state: SessionState): EntityId | null =>
  state.hovered ?? state.focusedTable;

export const isEntityActivated = (state: SessionState, id: EntityId): boolean =>
  activatedEntity(state) === id;

export const isActionHovered = (state: SessionState, target: EntityActionTarget): boolean =>
  sameTarget(state.hoveredAction, target);

export const isActionPressed = (state: SessionState, target: EntityActionTarget): boolean =>
  sameTarget(state.pressedAction, target);

export const isDragging = (state: SessionState): boolean => state.drag !== null;

export const isSelected = (state: SessionState, id: EntityId): boolean =>
  state.selection.includes(id);
