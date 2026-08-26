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
 *
 * `export` is a *choice* rather than a deed: pressing it reveals the formats,
 * and one of `export-csv`, `export-xlsx` or `export-parquet` is what actually
 * writes a file. Naming the three separately rather than parameterising one is
 * what lets an agent ask for a Parquet file in one message, and what keeps the
 * halo's buttons and the session's pressed-action state the same vocabulary.
 */
export type EntityActionId =
  | 'close'
  | 'edit'
  | 'sql'
  | 'chart'
  | 'rows'
  | 'export'
  | 'export-csv'
  | 'export-xlsx'
  | 'export-parquet'
  | 'export-svg'
  | 'export-png'
  | 'export-pdf';

/**
 * One piece of one chart: which box, which series, which value.
 *
 * A chart's marks are not entities — they are a projection of rows, exactly as a
 * table's cells are — so they are referred to by position rather than given ids.
 */
export interface ChartMarkTarget {
  readonly entityId: EntityId;
  readonly series: number;
  readonly data: number;
}

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
  /**
   * Columns picked out by clicking their headers, by column-view id.
   *
   * A flat set rather than a selection scoped to one table: column ids are
   * unique, so the set says which table each belongs to without being told, and
   * two tables side by side can each have columns picked out while they are
   * compared. Session state, like every other kind of selection — picking a
   * column out is not an edit to the document.
   */
  readonly selectedColumns: readonly EntityId[];
  /**
   * The piece of a chart under the pointer, and the pieces picked out.
   *
   * Session state, like every other selection here: pointing at a bar and
   * choosing one are not edits, and neither belongs in history. Holding them here
   * rather than inside the charting library also means they survive the chart
   * being re-laid-out — which happens whenever the box is resized or a dial
   * moves, and would otherwise quietly forget what the user had chosen.
   */
  readonly hoveredMark: ChartMarkTarget | null;
  readonly selectedMarks: readonly ChartMarkTarget[];
  readonly hoveredAction: EntityActionTarget | null;
  readonly pressedAction: EntityActionTarget | null;
  /**
   * The action whose choices are currently on show.
   *
   * Session state for the same reason a drag is: revealing the export formats
   * is not an edit, and it must not survive a reload or appear in history. The
   * halo grows the extra buttons rather than a menu opening over the canvas,
   * so the disclosure needs no new geometry, no new hit testing, and works
   * unchanged in a headset.
   */
  readonly expandedAction: EntityActionTarget | null;
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
  selectedColumns: [],
  hoveredMark: null,
  selectedMarks: [],
  hoveredAction: null,
  pressedAction: null,
  expandedAction: null,
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

export interface SetSelectedColumnsCommand {
  readonly type: 'SetSelectedColumns';
  readonly ids: readonly EntityId[];
}

export interface SetHoveredMarkCommand {
  readonly type: 'SetHoveredMark';
  readonly target: ChartMarkTarget | null;
}

export interface SetSelectedMarksCommand {
  readonly type: 'SetSelectedMarks';
  readonly targets: readonly ChartMarkTarget[];
}

export interface SetHoveredActionCommand {
  readonly type: 'SetHoveredAction';
  readonly target: EntityActionTarget | null;
}

export interface SetPressedActionCommand {
  readonly type: 'SetPressedAction';
  readonly target: EntityActionTarget | null;
}

export interface SetExpandedActionCommand {
  readonly type: 'SetExpandedAction';
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
  | SetSelectedColumnsCommand
  | SetHoveredMarkCommand
  | SetSelectedMarksCommand
  | SetExpandedActionCommand
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

const sameMark = (a: ChartMarkTarget | null, b: ChartMarkTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.entityId === b.entityId &&
    a.series === b.series &&
    a.data === b.data);

const sameMarks = (a: readonly ChartMarkTarget[], b: readonly ChartMarkTarget[]): boolean =>
  a.length === b.length && a.every((mark, index) => sameMark(mark, b[index] ?? null));

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
    case 'SetHovered': {
      if (state.hovered === command.id) return state;
      // Moving onto a *different* table folds the choices away: they belong to
      // the table that offered them, and two open halos would be two menus.
      const expanded =
        command.id !== null && state.expandedAction?.entityId !== command.id
          ? null
          : state.expandedAction;
      return { ...state, hovered: command.id, expandedAction: expanded };
    }
    case 'SetFocusedTable':
      return state.focusedTable === command.id ? state : { ...state, focusedTable: command.id };
    case 'BeginDrag':
      return { ...state, drag: command.drag };
    case 'EndDrag':
      return state.drag === null ? state : { ...state, drag: null };
    case 'SetPointer':
      return { ...state, pointer: command.pointer };
    case 'SetSelectedColumns':
      return sameIds(state.selectedColumns, command.ids)
        ? state
        : { ...state, selectedColumns: [...command.ids] };
    case 'SetHoveredMark':
      return sameMark(state.hoveredMark, command.target)
        ? state
        : { ...state, hoveredMark: command.target };
    case 'SetSelectedMarks':
      return sameMarks(state.selectedMarks, command.targets)
        ? state
        : { ...state, selectedMarks: [...command.targets] };
    case 'SetHoveredAction':
      return sameTarget(state.hoveredAction, command.target)
        ? state
        : { ...state, hoveredAction: command.target };
    case 'SetPressedAction':
      return sameTarget(state.pressedAction, command.target)
        ? state
        : { ...state, pressedAction: command.target };
    case 'SetExpandedAction':
      return sameTarget(state.expandedAction, command.target)
        ? state
        : { ...state, expandedAction: command.target };
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

export const isColumnSelected = (state: SessionState, columnId: EntityId): boolean =>
  state.selectedColumns.includes(columnId);

/** The action a table is currently showing the choices for, if any. */
/** The marks picked out in one chart, as that chart's own geometry names them. */
export const selectedMarksOf = (
  state: SessionState,
  entityId: EntityId,
): readonly { readonly series: number; readonly data: number }[] =>
  state.selectedMarks.filter((mark) => mark.entityId === entityId);

/** The mark under the pointer in one chart, if the pointer is in that one. */
export const hoveredMarkOf = (
  state: SessionState,
  entityId: EntityId,
): { readonly series: number; readonly data: number } | null =>
  state.hoveredMark?.entityId === entityId ? state.hoveredMark : null;

export const expandedActionOf = (state: SessionState, id: EntityId): EntityActionId | null =>
  state.expandedAction?.entityId === id ? state.expandedAction.action : null;

export const isDragging = (state: SessionState): boolean => state.drag !== null;

export const isSelected = (state: SessionState, id: EntityId): boolean =>
  state.selection.includes(id);
