import type {
  Binding,
  ChartMarkTarget,
  EntityActionId,
  EntityId,
  ForeignKeyReference,
  PanoramaCore,
  TableEntity,
} from '@panorama/core';
import type { CellValue } from '@panorama/table';
import {
  ROW_NUMBER_GUTTER_WIDTH,
  clamp,
  expandedActionOf,
  isBindingRevealed,
  isEntityActivated,
  connectorObstacles,
  resolveBinding,
} from '@panorama/core';
import type { ColumnLayout } from '@panorama/table';
import type { CameraController } from '../camera/camera-controller.js';
import type { TableTheme } from '../theme.js';
import type { TableHit } from './hit-test.js';
import { hitTestTable, toTableLocal } from './hit-test.js';
import { previewColumnWidth, previewEntity } from './drag-preview.js';
import { actionsForTable, computeHalo, withinHalo } from '../table/halo.js';
import { connectorMarker, routeConnector } from '../table/connector.js';
import { tableMetrics } from '../table/table-draw.js';
import type { NormalizedWheel, WheelSample } from './wheel.js';
import { normalizeWheel, wheelZoomFactor } from './wheel.js';

/**
 * The interaction controller.
 *
 * Pointer input never touches a mesh and never mutates the document directly.
 * It produces session state while a gesture is live and exactly one semantic
 * command when the gesture ends — the same command an agent would send.
 */

export interface PointerInput {
  /** CSS pixels relative to the canvas. */
  readonly screenX: number;
  readonly screenY: number;
  readonly button?: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

export interface TableViewState {
  readonly layout: ColumnLayout;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowCount: number | null;
}

/** A cell whose foreign key the user asked to follow. */
export interface ForeignKeyFollow {
  readonly tableId: EntityId;
  readonly columnId: EntityId;
  readonly row: number;
  readonly sourceColumn: string;
  readonly reference: ForeignKeyReference;
  readonly value: CellValue;
}

export interface InteractionHost {
  /** Table view state, or `null` when the table has no open data session yet. */
  viewOf(tableId: EntityId): TableViewState | null;
  /** Reads a cell, so a click can tell a followable value from a NULL. */
  cellAt(tableId: EntityId, row: number, columnIndex: number): CellValue | undefined;
  /** Scrolls a table by a pixel delta; the host owns smoothing and clamping. */
  scrollBy(tableId: EntityId, deltaX: number, deltaY: number): void;
  /** Scrolls to an absolute fraction, used by scrollbar drags. */
  scrollToFraction(tableId: EntityId, axis: 'vertical' | 'horizontal', fraction: number): void;
  /**
   * Actions this table cannot perform — a sample table has no SQL engine
   * behind it. The controller greys them out rather than hiding them, and
   * refuses to fire them.
   */
  disabledActionsFor?(tableId: EntityId): readonly EntityActionId[];
  /**
   * The piece of a chart at a point in the box's own coordinates, or `null`.
   *
   * Asked of the host because the geometry lives with whatever laid the chart
   * out; the controller's part is knowing that the pointer is over a chart's body
   * and where in it. Absent on a host that has no charts.
   */
  chartMarkAt?(
    tableId: EntityId,
    localX: number,
    localY: number,
  ): { readonly series: number; readonly data: number } | null;
}

export interface InteractionOptions {
  readonly core: PanoramaCore;
  readonly camera: CameraController;
  readonly host: InteractionHost;
  readonly theme: TableTheme;
  readonly gutterWidth?: number;
  /** Multiplies wheel deltas; tuned separately for wheels and trackpads. */
  readonly wheelScale?: number;
  readonly trackpadScale?: number;
  /**
   * Invoked when a halo action is triggered. The controller reports the intent;
   * performing it belongs to whoever owns the entity's lifecycle, because
   * closing a table also has to release its result set.
   */
  readonly onAction?: (entityId: EntityId, action: EntityActionId) => void;
  /**
   * Invoked when a foreign key cell is clicked. Like halo actions, the
   * controller reports the intent and the composition root performs it —
   * opening a table means talking to the database.
   */
  readonly onFollowForeignKey?: (follow: ForeignKeyFollow) => void;
}

/** A column selection being swept out with the pointer. */
interface ColumnDrag {
  readonly tableId: EntityId;
  readonly anchorColumnId: EntityId;
  headColumnId: EntityId;
  /** The selection the gesture began from; every step is applied to this. */
  readonly base: readonly EntityId[];
  /**
   * Whether the sweep gives columns or takes them away.
   *
   * Decided once, by the column the gesture began on: start on one that is not
   * picked out and the sweep picks out; start on one that is and the sweep puts
   * back. That is the same rule a single click follows, which makes a click the
   * shortest possible sweep rather than a case of its own — and it means a sweep
   * never has to guess, column by column, which of the two the user meant.
   */
  readonly mode: 'add' | 'remove';
}

export class InteractionController {
  readonly #core: PanoramaCore;
  readonly #camera: CameraController;
  readonly #host: InteractionHost;
  readonly #theme: TableTheme;
  readonly #gutterWidth: number;
  readonly #wheelScale: number;
  readonly #trackpadScale: number;
  readonly #options: InteractionOptions;
  #cursor = 'default';
  #lastPointer: PointerInput | null = null;
  /** The followable cell a press started on; a click must end on the same one. */
  #pressedCell: ForeignKeyFollow | null = null;
  /**
   * A column selection being swept out.
   *
   * Kept here rather than in session state, like the scrollbar drag: the
   * selection it produces *is* the session state, applied as the pointer moves,
   * so there is nothing left to preview.
   */
  #columnDrag: ColumnDrag | null = null;
  #scrollbarDrag: { tableId: EntityId; axis: 'vertical' | 'horizontal' } | null = null;

  constructor(options: InteractionOptions) {
    this.#options = options;
    this.#core = options.core;
    this.#camera = options.camera;
    this.#host = options.host;
    this.#theme = options.theme;
    this.#gutterWidth = options.gutterWidth ?? ROW_NUMBER_GUTTER_WIDTH;
    this.#wheelScale = options.wheelScale ?? 1;
    this.#trackpadScale = options.trackpadScale ?? 1;
  }

  get cursor(): string {
    return this.#cursor;
  }

  /**
   * The table a world point belongs to.
   *
   * Two passes. A table's own bounds win first, topmost down; only if no table
   * contains the point does the halo band above one claim it. Without the band
   * the pointer would deactivate a table the moment it left for a button, and
   * the button would vanish under the cursor; without the two passes the band
   * would shadow the body of whatever table sits beneath it.
   *
   * The band is claimed whatever the activation state, so a pointer that jumps
   * straight onto a button — a flick of the mouse is not a continuous path —
   * still lands on it.
   */
  entityAt(worldX: number, worldY: number): TableEntity | null {
    const world = this.#core.world;
    let banded: TableEntity | null = null;
    for (let index = world.order.length - 1; index >= 0; index -= 1) {
      const id = world.order[index] as EntityId;
      const entity = world.entities.get(id);
      if (entity === undefined) continue;
      const drawn = this.#drawn(entity);
      const local = toTableLocal(drawn, worldX, worldY);
      if (
        local.x >= 0 &&
        local.y >= 0 &&
        local.x < drawn.transform.width &&
        local.y < drawn.transform.height
      ) {
        return drawn;
      }
      if (banded === null && withinHalo(this.#haloOf(drawn), local.x, local.y)) {
        banded = drawn;
      }
    }
    return banded;
  }

  /**
   * The binding whose marker is under a world point.
   *
   * Connector lines are drawn behind tables, so a marker only answers where no
   * table covers it — the caller checks tables first. An already-revealed
   * marker is matched at its expanded size, so it does not collapse the moment
   * the pointer moves within the chip it just opened.
   */
  bindingMarkerAt(worldX: number, worldY: number): Binding | null {
    const world = this.#core.world;
    const transformOf = (id: EntityId): TableEntity['transform'] | undefined => {
      const stored = world.entities.get(id);
      return stored === undefined ? undefined : this.#drawn(stored).transform;
    };
    for (const binding of world.bindings.values()) {
      const resolved = resolveBinding(world, binding, transformOf);
      if (resolved === null) continue;
      // Routed, not merely resolved: a line that had to go round a table put its
      // marker on the way it actually went.
      const route = routeConnector(
        resolved,
        this.#theme,
        this.#camera.scale,
        connectorObstacles(world, binding, transformOf),
      );
      if (route === null) continue;
      const marker = connectorMarker(
        route.path,
        binding,
        this.#theme,
        this.#camera.scale,
        isBindingRevealed(this.#core.session, binding.id),
      );
      if (marker === null) continue;
      if (
        worldX >= marker.x &&
        worldX < marker.x + marker.width &&
        worldY >= marker.y &&
        worldY < marker.y + marker.height
      ) {
        return binding;
      }
    }
    return null;
  }

  /**
   * Picks a mark out, or lets it go.
   *
   * Additive, because comparing two bars is the reason anybody picks one out —
   * and pressing the background clears the lot, which is the way out that every
   * other selection here offers.
   */
  #toggleMark(entity: TableEntity, world: { readonly x: number; readonly y: number }): void {
    const mark =
      this.#host.chartMarkAt?.(
        entity.id,
        world.x - entity.transform.x,
        world.y - entity.transform.y,
      ) ?? null;
    const current = this.#core.session.selectedMarks;
    if (mark === null) {
      if (current.length > 0) {
        this.#core.dispatchSession({ type: 'SetSelectedMarks', targets: [] });
      }
      return;
    }
    const target: ChartMarkTarget = { entityId: entity.id, ...mark };
    const already = current.some(
      (entry) =>
        entry.entityId === target.entityId &&
        entry.series === target.series &&
        entry.data === target.data,
    );
    this.#core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: already
        ? current.filter(
            (entry) =>
              !(
                entry.entityId === target.entityId &&
                entry.series === target.series &&
                entry.data === target.data
              ),
          )
        : [...current, target],
    });
  }

  /**
   * The chart mark under the pointer, in whichever box the pointer is over.
   *
   * Only over a body: the title bar, the halo and the chrome are not the picture.
   */
  #markUnder(
    target: { readonly entity: TableEntity; readonly hit: TableHit } | null,
    world: { readonly x: number; readonly y: number },
  ): ChartMarkTarget | null {
    if (target === null || target.hit.kind !== 'body') return null;
    if (this.#host.chartMarkAt === undefined || target.entity.source.kind !== 'chart') return null;
    const mark = this.#host.chartMarkAt(
      target.entity.id,
      world.x - target.entity.transform.x,
      world.y - target.entity.transform.y,
    );
    return mark === null ? null : { entityId: target.entity.id, ...mark };
  }

  #showsHalo(entityId: EntityId): boolean {
    return isEntityActivated(this.#core.session, entityId);
  }

  /**
   * Spread into the hit-test input, so a host that reports nothing leaves the
   * optional field absent rather than present-and-undefined.
   */
  #disabledActions(tableId: EntityId): { disabledActions?: readonly EntityActionId[] } {
    const disabled = this.#host.disabledActionsFor?.(tableId);
    return disabled === undefined || disabled.length === 0 ? {} : { disabledActions: disabled };
  }

  #haloOf(entity: TableEntity): ReturnType<typeof computeHalo> {
    const view = this.#host.viewOf(entity.id);
    return computeHalo(
      tableMetrics(
        entity,
        view?.layout ?? { placements: [], totalWidth: 0 },
        view?.rowCount ?? null,
        this.#theme,
        this.#gutterWidth,
      ),
      this.#theme,
      this.#camera.scale,
      actionsForTable(entity, expandedActionOf(this.#core.session, entity.id)),
    );
  }

  /** The entity as currently drawn, including any in-flight drag preview. */
  #drawn(entity: TableEntity): TableEntity {
    const session = this.#core.session;
    return previewEntity(
      entity,
      session.drag,
      session.pointer?.world ?? null,
      this.#core.constraints,
    );
  }

  #hitAt(worldX: number, worldY: number): { entity: TableEntity; hit: TableHit } | null {
    const entity = this.entityAt(worldX, worldY);
    if (entity === null) return null;
    const view = this.#host.viewOf(entity.id);
    const local = toTableLocal(entity, worldX, worldY);
    // The halo is live for whichever table owns the point: either it is already
    // activated, or hovering here is what activates it.
    const inBand = withinHalo(this.#haloOf(entity), local.x, local.y);
    const hit = hitTestTable(
      {
        entity,
        layout: view?.layout ?? { placements: [], totalWidth: 0 },
        theme: this.#theme,
        scrollTop: view?.scrollTop ?? 0,
        scrollLeft: view?.scrollLeft ?? 0,
        rowCount: view?.rowCount ?? null,
        gutterWidth: this.#gutterWidth,
        scale: this.#camera.scale,
        showHalo: this.#showsHalo(entity.id) || inBand,
        expandedAction: expandedActionOf(this.#core.session, entity.id),
        ...this.#disabledActions(entity.id),
      },
      local.x,
      local.y,
    );
    return hit === null ? null : { entity, hit };
  }

  #setPointer(event: PointerInput): { x: number; y: number } {
    const world = this.#camera.screenToWorld(event.screenX, event.screenY);
    this.#core.dispatchSession({
      type: 'SetPointer',
      pointer: {
        world: { x: world.x, y: world.y, z: 0 },
        screenX: event.screenX,
        screenY: event.screenY,
      },
    });
    this.#lastPointer = event;
    return world;
  }

  onPointerDown(event: PointerInput): void {
    const world = this.#setPointer(event);
    // Seed the pan reference so the first move produces a real delta.
    this.#lastPointerBeforeMove = event;
    const target = this.#hitAt(world.x, world.y);

    if (target === null) {
      // A connector marker sits between tables; pressing it holds its detail
      // open, which is how a touch reveals what a hover would.
      const binding = this.bindingMarkerAt(world.x, world.y);
      if (binding !== null) {
        this.#core.dispatchSession({ type: 'SetPressedBinding', id: binding.id });
        this.#cursor = 'pointer';
        return;
      }
      this.#core.dispatchSession({ type: 'SetSelection', ids: [] });
      this.#core.dispatchSession({
        type: 'BeginDrag',
        drag: { kind: 'pan-canvas', pointerStart: { x: world.x, y: world.y, z: 0 } },
      });
      this.#cursor = 'grabbing';
      return;
    }

    const { entity, hit } = target;

    // A halo press must not re-select or start a drag: it is a button. A press
    // in the band between the table and its buttons does nothing at all.
    if (hit.kind === 'halo') {
      if (hit.action !== null && !hit.disabled) {
        this.#core.dispatchSession({
          type: 'SetPressedAction',
          target: { entityId: entity.id, action: hit.action },
        });
      }
      this.#cursor = hit.cursor;
      return;
    }

    this.#core.dispatchSession({ type: 'SetSelection', ids: [entity.id] });

    switch (hit.kind) {
      case 'title':
        this.#core.dispatchSession({
          type: 'BeginDrag',
          drag: {
            kind: 'move-entity',
            entityId: entity.id,
            pointerStart: { x: world.x, y: world.y, z: 0 },
            entityStart: {
              x: entity.transform.x,
              y: entity.transform.y,
              z: entity.transform.z,
            },
          },
        });
        this.#cursor = 'grabbing';
        return;
      case 'resize':
        this.#core.dispatchSession({
          type: 'BeginDrag',
          drag: {
            kind: 'resize-entity',
            entityId: entity.id,
            handle: hit.handle,
            pointerStart: { x: world.x, y: world.y, z: 0 },
            entityStart: {
              x: entity.transform.x,
              y: entity.transform.y,
              z: entity.transform.z,
            },
            widthStart: entity.transform.width,
            heightStart: entity.transform.height,
          },
        });
        this.#cursor = hit.cursor;
        return;
      case 'column-resize':
        this.#core.dispatchSession({
          type: 'BeginDrag',
          drag: {
            kind: 'resize-column',
            entityId: entity.id,
            columnId: hit.column.id,
            pointerStart: { x: world.x, y: world.y, z: 0 },
            widthStart: hit.column.width,
          },
        });
        this.#cursor = 'col-resize';
        return;
      case 'scrollbar':
        this.#scrollbarDrag = { tableId: entity.id, axis: hit.axis };
        this.#applyScrollbarDrag(entity, hit.axis, world);
        return;
      case 'header': {
        // The header above the gutter names no column, so there is nothing to
        // pick out there.
        if (hit.column === null) {
          this.#cursor = hit.cursor;
          return;
        }
        const base = this.#core.session.selectedColumns;
        const drag: ColumnDrag = {
          tableId: entity.id,
          anchorColumnId: hit.column.id,
          headColumnId: hit.column.id,
          base,
          mode: base.includes(hit.column.id) ? 'remove' : 'add',
        };
        this.#columnDrag = drag;
        // Applied on the way down, so the gesture answers under the finger
        // straight away and keeps answering as it sweeps. Nothing is undone on
        // release, so there is nothing to flicker.
        this.#applyColumnSweep(drag, [hit.column.id]);
        this.#cursor = hit.cursor;
        return;
      }
      case 'body': {
        // A chart's body is a picture, not a grid: a press picks a mark out
        // rather than following a key, and pressing the background lets go of
        // whatever was picked.
        if (entity.source.kind === 'chart') {
          this.#toggleMark(entity, world);
          this.#cursor = hit.cursor;
          return;
        }
        this.#pressedCell = this.#followableCell(entity, hit.row, hit.column);
        this.#cursor = hit.cursor;
        return;
      }
      default:
        this.#cursor = hit.cursor;
    }
  }

  /** Describes a cell if its column carries a followable foreign key. */
  #followableCell(
    entity: TableEntity,
    row: number,
    column: {
      readonly id: EntityId;
      readonly sourceIndex: number;
      readonly column: TableEntity['columns'][number];
    } | null,
  ): ForeignKeyFollow | null {
    if (column === null || row < 0) return null;
    const reference = column.column.sourceColumn.foreignKey;
    if (reference === undefined) return null;
    const value = this.#host.cellAt(entity.id, row, column.sourceIndex);
    // A NULL, or a cell whose block has not arrived, points at nothing.
    if (value === undefined || value === null) return null;
    return {
      tableId: entity.id,
      columnId: column.id,
      row,
      sourceColumn: column.column.sourceColumn.name,
      reference,
      value,
    };
  }

  onPointerMove(event: PointerInput): void {
    const world = this.#setPointer(event);
    const drag = this.#core.session.drag;

    if (this.#columnDrag !== null) {
      this.#extendColumnDrag(world);
      return;
    }

    if (this.#scrollbarDrag !== null) {
      const entity = this.#core.world.entities.get(this.#scrollbarDrag.tableId);
      if (entity !== undefined) {
        this.#applyScrollbarDrag(entity, this.#scrollbarDrag.axis, world);
      }
      return;
    }

    if (drag?.kind === 'pan-canvas') {
      // Panning works in screen space so the world follows the pointer exactly.
      const previous = this.#previousScreen(event);
      this.#camera.panByScreen(event.screenX - previous.x, event.screenY - previous.y);
      return;
    }

    if (drag !== null) return; // A live drag is previewed from session state.

    const target = this.#hitAt(world.x, world.y);
    const binding = target === null ? this.bindingMarkerAt(world.x, world.y) : null;
    this.#core.dispatchSession({ type: 'SetHoveredBinding', id: binding?.id ?? null });
    this.#cursor =
      binding !== null
        ? 'pointer'
        : target !== null &&
            target.hit.kind === 'body' &&
            this.#followableCell(target.entity, target.hit.row, target.hit.column) !== null
          ? 'pointer'
          : (target?.hit.cursor ?? 'default');
    this.#core.dispatchSession({
      type: 'SetHovered',
      id: target?.entity.id ?? null,
    });
    const mark = this.#markUnder(target, world);
    this.#core.dispatchSession({ type: 'SetHoveredMark', target: mark });
    // A mark can be picked out, so it says so under the pointer — the same
    // affordance a followable cell gets.
    if (mark !== null) this.#cursor = 'pointer';
    this.#core.dispatchSession({
      type: 'SetHoveredAction',
      target:
        target !== null &&
        target.hit.kind === 'halo' &&
        target.hit.action !== null &&
        !target.hit.disabled
          ? { entityId: target.entity.id, action: target.hit.action }
          : null,
    });
    // From the same hit test that decides what a click would do, rather than
    // from the pointer's position worked out again: a header lights up exactly
    // where clicking it would pick the column out, so the hint cannot promise
    // something the click does not do. A resize edge is a `column-resize` hit
    // and the row numbers are a header hit naming no column, so neither lights.
    this.#core.dispatchSession({
      type: 'SetHoveredColumn',
      id: target !== null && target.hit.kind === 'header' ? (target.hit.column?.id ?? null) : null,
    });
  }

  #selectColumns(ids: readonly EntityId[]): void {
    this.#core.dispatchSession({ type: 'SetSelectedColumns', ids });
  }

  /**
   * Applies a sweep's range to the selection it began from.
   *
   * Always from `base` rather than from whatever the last step left, so a sweep
   * that runs out too far and comes back leaves what is between its ends —
   * whichever direction it is painting in.
   */
  #applyColumnSweep(drag: ColumnDrag, swept: readonly EntityId[]): void {
    this.#selectColumns(
      drag.mode === 'remove'
        ? drag.base.filter((id) => !swept.includes(id))
        : [...drag.base, ...swept.filter((id) => !drag.base.includes(id))],
    );
  }

  /**
   * Grows the sweep to the column under the pointer.
   *
   * The range runs between the column the gesture began on and the one it is
   * over now, in the order the columns are laid out — so sweeping right and then
   * back left leaves what is between them, rather than everything the pointer
   * has ever touched.
   */
  #extendColumnDrag(world: { x: number; y: number }): void {
    const drag = this.#columnDrag;
    if (drag === null) return;
    const target = this.#hitAt(world.x, world.y);
    if (target === null || target.entity.id !== drag.tableId) return;
    const hit = target.hit;
    // A header or a cell will do: a pointer sweeping sideways drifts out of the
    // header band, and losing the gesture there would be unforgiving.
    const column = hit.kind === 'header' || hit.kind === 'body' ? hit.column : null;
    if (column === null || column.id === drag.headColumnId) return;

    const placements = this.#host.viewOf(drag.tableId)?.layout.placements ?? [];
    const from = placements.findIndex((placement) => placement.id === drag.anchorColumnId);
    const to = placements.findIndex((placement) => placement.id === column.id);
    if (from < 0 || to < 0) return;

    drag.headColumnId = column.id;
    this.#applyColumnSweep(
      drag,
      placements.slice(Math.min(from, to), Math.max(from, to) + 1).map((placement) => placement.id),
    );
  }

  #previousScreen(event: PointerInput): { x: number; y: number } {
    const previous = this.#lastPointerBeforeMove ?? event;
    this.#lastPointerBeforeMove = event;
    return { x: previous.screenX, y: previous.screenY };
  }

  #lastPointerBeforeMove: PointerInput | null = null;

  /** Ends the gesture and commits exactly one semantic command. */
  onPointerUp(event: PointerInput): void {
    const world = this.#setPointer(event);
    this.#scrollbarDrag = null;
    this.#lastPointerBeforeMove = null;
    // A press-and-hold on a connector marker ends with the release.
    this.#core.dispatchSession({ type: 'SetPressedBinding', id: null });

    // A button fires on release over the same button, so a press can be
    // abandoned by moving away — the convention everywhere else.
    const pressed = this.#core.session.pressedAction;
    if (pressed !== null) {
      this.#core.dispatchSession({ type: 'SetPressedAction', target: null });
      const target = this.#hitAt(world.x, world.y);
      if (
        target !== null &&
        target.hit.kind === 'halo' &&
        target.entity.id === pressed.entityId &&
        target.hit.action === pressed.action
      ) {
        this.#options.onAction?.(pressed.entityId, pressed.action);
      }
      return;
    }

    // A column sweep has nothing left to do on release: every step of it was
    // applied as the pointer moved, and the shortest sweep is the click.
    if (this.#columnDrag !== null) {
      this.#columnDrag = null;
      return;
    }

    // A click on a foreign key cell: same cell down and up, no drag between.
    const pressedCell = this.#pressedCell;
    this.#pressedCell = null;
    if (pressedCell !== null) {
      const target = this.#hitAt(world.x, world.y);
      if (
        target !== null &&
        target.hit.kind === 'body' &&
        target.entity.id === pressedCell.tableId &&
        target.hit.row === pressedCell.row &&
        target.hit.column?.id === pressedCell.columnId
      ) {
        this.#options.onFollowForeignKey?.(pressedCell);
      }
    }

    const drag = this.#core.session.drag;
    if (drag === null) return;
    this.#core.dispatchSession({ type: 'EndDrag' });
    this.#cursor = 'default';

    switch (drag.kind) {
      case 'move-entity': {
        const dx = world.x - drag.pointerStart.x;
        const dy = world.y - drag.pointerStart.y;
        if (dx === 0 && dy === 0) return;
        this.#core.dispatch({
          type: 'MoveEntities',
          ids: [drag.entityId],
          position: {
            x: drag.entityStart.x + dx,
            y: drag.entityStart.y + dy,
            z: drag.entityStart.z,
          },
        });
        return;
      }
      case 'resize-entity': {
        const entity = this.#core.world.entities.get(drag.entityId);
        if (entity === undefined) return;
        const transform = previewEntity(
          entity,
          drag,
          { x: world.x, y: world.y },
          this.#core.constraints,
        ).transform;
        this.#core.dispatch({
          type: 'ResizeEntity',
          id: drag.entityId,
          width: transform.width,
          height: transform.height,
          position: { x: transform.x, y: transform.y, z: transform.z },
        });
        return;
      }
      case 'resize-column': {
        const width = previewColumnWidth(
          drag,
          { x: world.x, y: world.y },
          drag.columnId,
          drag.widthStart,
          this.#core.constraints,
        );
        if (width === drag.widthStart) return;
        this.#core.dispatch({
          type: 'ResizeColumn',
          tableId: drag.entityId,
          columnId: drag.columnId,
          width,
        });
        return;
      }
      case 'pan-canvas':
        return;
    }
  }

  onPointerLeave(): void {
    this.#pressedCell = null;
    this.#columnDrag = null;
    this.#core.dispatchSession({ type: 'SetHoveredBinding', id: null });
    this.#core.dispatchSession({ type: 'SetPressedBinding', id: null });
    this.#core.dispatchSession({ type: 'SetPointer', pointer: null });
    this.#core.dispatchSession({ type: 'SetHovered', id: null });
    this.#core.dispatchSession({ type: 'SetHoveredMark', target: null });
    this.#core.dispatchSession({ type: 'SetHoveredAction', target: null });
    this.#core.dispatchSession({ type: 'SetPressedAction', target: null });
    this.#core.dispatchSession({ type: 'SetHoveredColumn', id: null });
    this.#cursor = 'default';
  }

  /**
   * Wheel handling. Over a table body the wheel scrolls rows; elsewhere it
   * pans the canvas. Ctrl/⌘ zooms, matching every other canvas application.
   */
  onWheel(sample: WheelSample, event: PointerInput): NormalizedWheel {
    const wheel = normalizeWheel(sample);
    const world = this.#camera.screenToWorld(event.screenX, event.screenY);

    if (wheel.zoom) {
      this.#camera.zoomAt(event.screenX, event.screenY, wheelZoomFactor(wheel.pixelsY));
      return wheel;
    }

    const scale = wheel.device === 'trackpad' ? this.#trackpadScale : this.#wheelScale;
    const target = this.#hitAt(world.x, world.y);
    const overBody =
      target !== null && (target.hit.kind === 'body' || target.hit.kind === 'gutter');

    if (overBody) {
      // Wheel deltas are screen pixels; scrolling happens in table units.
      const factor = scale / this.#camera.scale;
      this.#host.scrollBy(target.entity.id, wheel.pixelsX * factor, wheel.pixelsY * factor);
      return wheel;
    }

    this.#camera.panByScreen(-wheel.pixelsX * scale, -wheel.pixelsY * scale);
    return wheel;
  }

  #applyScrollbarDrag(
    entity: TableEntity,
    axis: 'vertical' | 'horizontal',
    world: { x: number; y: number },
  ): void {
    const local = toTableLocal(entity, world.x, world.y);
    const fraction =
      axis === 'vertical'
        ? (local.y - entity.view.headerHeight) /
          Math.max(1, entity.transform.height - entity.view.headerHeight)
        : (local.x - this.#gutterWidth) / Math.max(1, entity.transform.width - this.#gutterWidth);
    this.#host.scrollToFraction(entity.id, axis, clamp(fraction, 0, 1));
  }

  /** Exposed for the canvas element, which mirrors it onto `style.cursor`. */
  get lastPointer(): PointerInput | null {
    return this.#lastPointer;
  }
}
