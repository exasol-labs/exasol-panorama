import type { EntityActionId, EntityId, PanoramaCore, TableEntity } from '@panorama/core';
import { ROW_NUMBER_GUTTER_WIDTH, clamp, isEntityActivated } from '@panorama/core';
import type { ColumnLayout } from '@panorama/table';
import type { CameraController } from '../camera/camera-controller.js';
import type { TableTheme } from '../theme.js';
import type { TableHit } from './hit-test.js';
import { hitTestTable, toTableLocal } from './hit-test.js';
import { previewColumnWidth, previewEntity } from './drag-preview.js';
import { computeHalo, withinHalo } from '../table/halo.js';
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

export interface InteractionHost {
  /** Table view state, or `null` when the table has no open data session yet. */
  viewOf(tableId: EntityId): TableViewState | null;
  /** Scrolls a table by a pixel delta; the host owns smoothing and clamping. */
  scrollBy(tableId: EntityId, deltaX: number, deltaY: number): void;
  /** Scrolls to an absolute fraction, used by scrollbar drags. */
  scrollToFraction(tableId: EntityId, axis: 'vertical' | 'horizontal', fraction: number): void;
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
   * The topmost table whose drawn bounds contain a world point.
   *
   * An activated table also claims its halo, which sits outside those bounds —
   * without that, moving the pointer from the table onto a halo button would
   * deactivate the table and the button would vanish under the cursor.
   */
  entityAt(worldX: number, worldY: number): TableEntity | null {
    const world = this.#core.world;
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
      if (this.#showsHalo(drawn.id) && withinHalo(this.#haloOf(drawn), local.x, local.y)) {
        return drawn;
      }
    }
    return null;
  }

  #showsHalo(entityId: EntityId): boolean {
    return isEntityActivated(this.#core.session, entityId);
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
        showHalo: this.#showsHalo(entity.id),
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
      this.#core.dispatchSession({ type: 'SetSelection', ids: [] });
      this.#core.dispatchSession({
        type: 'BeginDrag',
        drag: { kind: 'pan-canvas', pointerStart: { x: world.x, y: world.y, z: 0 } },
      });
      this.#cursor = 'grabbing';
      return;
    }

    const { entity, hit } = target;

    // A halo press must not re-select or start a drag: it is a button.
    if (hit.kind === 'halo') {
      this.#core.dispatchSession({
        type: 'SetPressedAction',
        target: { entityId: entity.id, action: hit.action },
      });
      this.#cursor = 'pointer';
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
      default:
        this.#cursor = hit.cursor;
    }
  }

  onPointerMove(event: PointerInput): void {
    const world = this.#setPointer(event);
    const drag = this.#core.session.drag;

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
    this.#cursor = target?.hit.cursor ?? 'default';
    this.#core.dispatchSession({
      type: 'SetHovered',
      id: target?.entity.id ?? null,
    });
    this.#core.dispatchSession({
      type: 'SetHoveredAction',
      target:
        target !== null && target.hit.kind === 'halo'
          ? { entityId: target.entity.id, action: target.hit.action }
          : null,
    });
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
    this.#core.dispatchSession({ type: 'SetPointer', pointer: null });
    this.#core.dispatchSession({ type: 'SetHovered', id: null });
    this.#core.dispatchSession({ type: 'SetHoveredAction', target: null });
    this.#core.dispatchSession({ type: 'SetPressedAction', target: null });
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
