import type {
  EntityActionId,
  EntityId,
  PanoramaCore,
  TableEntity,
  TableColumnView,
} from '@panorama/core';
import {
  ROW_NUMBER_GUTTER_WIDTH,
  expandedActionOf,
  isBindingRevealed,
  connectorObstacles,
  isEntityActivated,
  isTableEntity,
  rectsIntersect,
  resolveBinding,
} from '@panorama/core';
import type { ColumnLayout } from '@panorama/table';
import { computeColumnLayout } from '@panorama/table';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { WebXRDefaultExperience } from '@babylonjs/core/XR/webXRDefaultExperience.js';
import { CameraController } from '../camera/camera-controller.js';
import { XrStage } from './xr-stage.js';

/** Panorama is a seated/standing panel, not a room-scale experience. */
const XR_SESSION_MODE = 'immersive-vr';
import type { LodThresholds } from '../table/lod.js';
import { lodForScale } from '../table/lod.js';
import type { TableDataView } from '../table/table-draw.js';
import type { SummaryPanelView } from '../table/summary-panel.js';
import { SUMMARY_PANEL_GAP, SUMMARY_PANEL_MAX_HEIGHT } from '../table/summary-panel.js';
import { buildTableDrawList, chartBoxLayout } from '../table/table-draw.js';
import { buildConnectorDrawList } from '../table/connector.js';
import { previewEntity } from '../input/drag-preview.js';
import { AtlasTextRenderer } from '../text/text-renderer.js';
import type { TextSystem, TextSystemFactory } from './text-system.js';
import { createCanvasTextSystem } from './text-system.js';
import type { Rgba, TableTheme } from '../theme.js';
import type { ChartDrawList, ChartMetrics, ClipRect, TextRun } from '../table/draw-list.js';
import { DEFAULT_FONT_FAMILY } from '../text/canvas-rasterizer.js';
import { DEFAULT_TABLE_THEME } from '../theme.js';
import { PanoramaScene, toBabylonY } from './scene.js';
import { QuadBatch } from './quad-batch.js';
import { createSolidMaterial } from './materials.js';
import type { FrameStats } from '../instrumentation/frame-stats.js';
import { FrameStatsCollector } from '../instrumentation/frame-stats.js';

/**
 * The Panorama renderer.
 *
 * A projection of the world model: it reads document state, session state and
 * table data, and writes GPU buffers. It never mutates persistent state, and
 * it never waits for the database.
 */

export interface TableViewModel {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowCount: number | null;
  readonly data: TableDataView;
}

export interface TableViewProvider {
  /** View state for a table, or `null` when its data session is not open yet. */
  viewFor(entity: TableEntity): TableViewModel | null;
  /**
   * Halo actions this table cannot perform. A capability of whatever backs the
   * table rather than of the table itself, which is why it comes from the host
   * and is not recorded on the entity.
   */
  disabledActionsFor?(entity: TableEntity): readonly EntityActionId[];
  /**
   * Statistics for this table's picked-out columns, keyed by column-view id.
   *
   * From the host because a summary is an answer from the data source, arriving
   * over a worker boundary long after the click that asked for it.
   */
  columnSummariesFor?(entity: TableEntity): ReadonlyMap<EntityId, SummaryPanelView> | undefined;
  /**
   * One line about what became of this box's statement, where anything did.
   *
   * From the host for the same reason a summary is: it is what the database made
   * of the statement, which the renderer has no way to know and is told.
   */
  statementNoteFor?(entity: TableEntity): string | undefined;
  /**
   * The chart this box draws, laid out for the given body size, and anything it
   * needs to admit about the rows it read.
   */
  chartFor?(
    entity: TableEntity,
    width: number,
    height: number,
    metrics: ChartMetrics,
  ): ChartView | undefined;
}

export interface ChartView {
  readonly chart: ChartDrawList;
  readonly note?: string;
  /** True when the note is a caveat rather than a statement of fact. */
  readonly caution?: boolean;
}

export interface PanoramaRendererOptions {
  readonly core: PanoramaCore;
  readonly engine: AbstractEngine;
  readonly views: TableViewProvider;
  readonly theme?: TableTheme;
  readonly atlasSize?: number;
  readonly pixelRatio?: number;
  readonly lodThresholds?: LodThresholds;
  readonly gutterWidth?: number;
  readonly clock?: () => number;
  /** Injected in tests and by any future non-canvas text implementation. */
  readonly createTextSystem?: TextSystemFactory;
  /**
   * Called at the top of every frame with the elapsed milliseconds, before any
   * geometry is built. This is where scroll smoothing and viewport requests
   * happen, so the frame always draws the newest state.
   */
  readonly beforeFrame?: (deltaMs: number) => void;
}

const EMPTY_DATA: TableDataView = { cell: () => undefined };

export class PanoramaRenderer {
  readonly camera = new CameraController();
  readonly scene: PanoramaScene;
  readonly text: AtlasTextRenderer;
  readonly theme: TableTheme;

  readonly #core: PanoramaCore;
  readonly #options: PanoramaRendererOptions;
  readonly #views: TableViewProvider;
  readonly #stage: XrStage;
  #xr: WebXRDefaultExperience | null = null;
  /** `null` until support has been probed; cached thereafter. */
  #xrSupported: boolean | null = null;
  readonly #solid: QuadBatch;
  readonly #glyphs: QuadBatch;
  readonly #atlas: import('../text/glyph-atlas.js').GlyphAtlas;
  readonly #stats: FrameStatsCollector;
  readonly #lodThresholds: LodThresholds | undefined;
  readonly #gutterWidth: number;
  readonly #textSystem: TextSystem;
  readonly #layoutCache = new WeakMap<readonly TableColumnView[], ColumnLayout>();
  #atlasVersion = -1;
  #running = false;

  constructor(options: PanoramaRendererOptions) {
    this.#options = options;
    this.#core = options.core;
    this.#views = options.views;
    this.theme = options.theme ?? DEFAULT_TABLE_THEME;
    this.#lodThresholds = options.lodThresholds;
    this.#gutterWidth = options.gutterWidth ?? ROW_NUMBER_GUTTER_WIDTH;
    this.#stats = new FrameStatsCollector(
      options.clock === undefined ? {} : { clock: options.clock },
    );

    this.scene = new PanoramaScene({
      engine: options.engine,
      clearColor: this.theme.canvasBackground,
    });

    const atlasSize = options.atlasSize ?? 1_024;
    const createTextSystem = options.createTextSystem ?? createCanvasTextSystem;
    this.#textSystem = createTextSystem(this.scene.scene, atlasSize, options.pixelRatio ?? 1);
    this.#atlas = this.#textSystem.atlas;
    this.text = new AtlasTextRenderer(this.#atlas);

    this.#stage = new XrStage(this.scene.scene);
    this.#solid = new QuadBatch({ name: 'panorama-solid', scene: this.scene.scene });
    this.#solid.setMaterial(createSolidMaterial(this.scene.scene));
    this.#glyphs = new QuadBatch({
      name: 'panorama-glyphs',
      scene: this.scene.scene,
      textured: true,
    });
    this.#glyphs.setMaterial(this.#textSystem.material);
    // Glyphs draw after every solid quad, in one extra draw call.
    this.#glyphs.mesh.renderingGroupId = 1;
    // Everything drawn hangs from the stage, so entering XR is one transform
    // rather than a second copy of the geometry.
    this.#solid.mesh.parent = this.#stage.root;
    this.#glyphs.mesh.parent = this.#stage.root;
  }

  get stats(): FrameStats {
    return this.#stats.stats;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The size of the picture drawn, in CSS pixels. */
  resize(width: number, height: number): void {
    this.camera.setViewport({ width, height });
  }

  /** How much of that picture the window is currently showing. */
  setVisible(width: number, height: number): void {
    this.camera.setVisible({ width, height });
  }

  /** Column layout for a table, memoised on the column array identity. */
  layoutFor(entity: TableEntity): ColumnLayout {
    const cached = this.#layoutCache.get(entity.columns);
    if (cached !== undefined) return cached;
    const layout = computeColumnLayout(entity.columns);
    this.#layoutCache.set(entity.columns, layout);
    return layout;
  }

  /** The entity as it is currently drawn, including any live drag preview. */
  drawnEntity(entity: TableEntity): TableEntity {
    const session = this.#core.session;
    return previewEntity(
      entity,
      session.drag,
      session.pointer?.world ?? null,
      this.#core.constraints,
    );
  }

  #disabledActions(entity: TableEntity): { disabledActions?: readonly EntityActionId[] } {
    const disabled = this.#views.disabledActionsFor?.(entity);
    return disabled === undefined || disabled.length === 0 ? {} : { disabledActions: disabled };
  }

  /**
   * Every other table, in this table's coordinates.
   *
   * Only asked for when this table has a panel to place, so the cost lands on the
   * one table with columns picked out rather than on every frame of every table.
   */
  #neighbours(entity: TableEntity): readonly ClipRect[] {
    const rects: ClipRect[] = [];
    for (const other of this.#core.world.entities.values()) {
      if (other.id === entity.id || !isTableEntity(other)) continue;
      rects.push({
        x: other.transform.x - entity.transform.x,
        y: other.transform.y - entity.transform.y,
        width: other.transform.width,
        height: other.transform.height,
      });
    }
    return rects;
  }

  /**
   * Asks the host to lay this box's chart out for the body it has to fill.
   *
   * The size is passed in rather than read back, because the box may be being
   * dragged or resized and the chart has to be laid out for the rectangle that is
   * about to be drawn, not the one that was committed.
   */
  readonly #chartMetrics: ChartMetrics = {
    measureText: (text, fontSize, bold): number => this.text.measure(text, fontSize, bold),
    fontFamily: DEFAULT_FONT_FAMILY,
  };

  #chart(entity: TableEntity): {
    chart?: ChartDrawList;
    chartNote?: string;
    chartNoteCaution?: boolean;
  } {
    if (this.#views.chartFor === undefined || entity.source.kind !== 'chart') return {};
    // The same split the drawing does, so the picture is laid out for the exact
    // rectangle it ends up in — beside the controls while they are open, and the
    // whole body once they are not.
    const box = chartBoxLayout(
      entity.transform.width,
      entity.transform.height,
      this.theme,
      entity.mode === 'editing',
    );
    const view = this.#views.chartFor(
      entity,
      Math.max(1, box.chart.width),
      Math.max(1, box.chart.height),
      this.#chartMetrics,
    );
    if (view === undefined) return {};
    return {
      chart: view.chart,
      ...(view.note === undefined ? {} : { chartNote: view.note }),
      ...(view.caution === true ? { chartNoteCaution: true } : {}),
    };
  }

  #statementNote(entity: TableEntity): { statementNote?: string } {
    const note = this.#views.statementNoteFor?.(entity);
    return note === undefined ? {} : { statementNote: note };
  }

  #columnSummaries(entity: TableEntity): {
    columnSummaries?: ReadonlyMap<EntityId, SummaryPanelView>;
  } {
    const summaries = this.#views.columnSummariesFor?.(entity);
    return summaries === undefined || summaries.size === 0 ? {} : { columnSummaries: summaries };
  }

  #hoveredRow(entity: TableEntity, view: TableViewModel | null): number | null {
    const session = this.#core.session;
    if (session.hovered !== entity.id || session.pointer === null || view === null) return null;
    const localY = session.pointer.world.y - entity.transform.y;
    if (localY < entity.view.headerHeight) return null;
    return Math.floor((localY - entity.view.headerHeight + view.scrollTop) / entity.view.rowHeight);
  }

  /**
   * Draws every binding whose line crosses the viewport, and reports how many.
   *
   * Endpoints resolve against *drawn* transforms, so a connector follows a
   * table live while it is being dragged rather than snapping at the end.
   */
  #drawConnectors(
    visibleRect: { x: number; y: number; width: number; height: number },
    markers: Array<{
      readonly polygons: readonly { corners: readonly number[]; color: Rgba }[];
      readonly texts: readonly TextRun[];
    }>,
  ): number {
    const world = this.#core.world;
    if (world.bindings.size === 0) return 0;
    const transformOf = (id: EntityId): TableEntity['transform'] | undefined => {
      const stored = world.entities.get(id);
      return stored === undefined ? undefined : this.drawnEntity(stored).transform;
    };

    let drawn = 0;
    for (const binding of world.bindings.values()) {
      const resolved = resolveBinding(world, binding, transformOf);
      if (resolved === null || resolved.degenerate) continue;
      const list = buildConnectorDrawList({
        resolved,
        theme: this.theme,
        scale: this.camera.scale,
        // Every other table: the line goes round them where it can, because a
        // line that passes behind one does not read as a line behind a table but
        // as a line that stops and starts again somewhere else.
        obstacles: connectorObstacles(world, binding, transformOf),
        highlighted:
          isEntityActivated(this.#core.session, binding.fromId) ||
          isEntityActivated(this.#core.session, binding.toId),
        revealed: isBindingRevealed(this.#core.session, binding.id),
      });
      if (!rectsIntersect(list.bounds, visibleRect)) continue;

      for (const polygon of list.polygons) this.#pushWorldPolygon(polygon);
      markers.push({ polygons: list.markerPolygons, texts: list.texts });
      drawn += 1;
    }
    return drawn;
  }

  /** Pushes a world-space polygon, converting to Babylon's upward y. */
  #pushWorldPolygon(polygon: { corners: readonly number[]; color: Rgba }): void {
    this.#solid.pushCorners(
      [
        polygon.corners[0] as number,
        toBabylonY(polygon.corners[1] as number),
        polygon.corners[2] as number,
        toBabylonY(polygon.corners[3] as number),
        polygon.corners[4] as number,
        toBabylonY(polygon.corners[5] as number),
        polygon.corners[6] as number,
        toBabylonY(polygon.corners[7] as number),
      ],
      0,
      polygon.color,
    );
  }

  /** Lays out a world-space text run into the glyph batch. */
  #pushWorldText(run: TextRun): void {
    for (const glyph of this.text.layout(run).quads) {
      this.#glyphs.push(glyph.x, toBabylonY(glyph.y), 0, glyph.width, glyph.height, glyph.color, [
        glyph.u0,
        glyph.v0,
        glyph.u1,
        glyph.v1,
      ]);
    }
  }

  /**
   * Pans — without zooming — until an entity is fully on screen. Used when a
   * table is opened, so it appears where the user is already looking instead of
   * somewhere off the edge of the canvas.
   */
  revealEntity(id: EntityId, margin = 48): void {
    const entity = this.#core.world.entities.get(id);
    if (entity === undefined) return;
    const view = this.camera.visibleWorldRect();
    const inset = margin / this.camera.scale;
    const { x, y, width, height } = entity.transform;

    const shift = (start: number, size: number, viewStart: number, viewSize: number): number => {
      const available = viewSize - inset * 2;
      // A table larger than the viewport is aligned to its top-left corner.
      if (size >= available) return start - inset - viewStart;
      if (start < viewStart + inset) return start - inset - viewStart;
      if (start + size > viewStart + viewSize - inset) {
        return start + size + inset - (viewStart + viewSize);
      }
      return 0;
    };

    const dx = shift(x, width, view.x, view.width);
    const dy = shift(y, height, view.y, view.height);
    if (dx === 0 && dy === 0) return;
    this.camera.moveTo(this.camera.state.centerX + dx, this.camera.state.centerY + dy);
  }

  /** Builds and uploads one frame. Never allocates a scene node per cell. */
  renderFrame(deltaMs = 16.67): void {
    this.#stats.beginFrame();
    this.#options.beforeFrame?.(deltaMs);
    this.scene.syncCamera(this.camera);
    this.#solid.begin();
    this.#glyphs.begin();

    // Everything drawn, not everything seen: the canvas is larger than the window
    // shows, and the part beyond the edge is what a resize reveals.
    const visibleRect = this.camera.drawnWorldRect();
    const lod = lodForScale(this.camera.scale, this.#lodThresholds);
    const session = this.#core.session;
    const selection = new Set(session.selection);
    // Built once for the frame, and empty on almost every frame: without it,
    // deciding whether a table has a column picked out is a scan of its columns
    // against a list, per table, per frame — which on a five-thousand-column
    // table is five thousand comparisons to answer "no".
    const pickedColumns =
      session.selectedColumns.length === 0 ? null : new Set(session.selectedColumns);
    // Connector lines are drawn first so they pass behind the tables they join,
    // emerging from the borders rather than crossing the data. Their markers
    // are held back and drawn afterwards, in front.
    const markers: Array<{
      readonly polygons: readonly { corners: readonly number[]; color: Rgba }[];
      readonly texts: readonly TextRun[];
    }> = [];
    const connectors = this.#drawConnectors(visibleRect, markers);
    let visibleRows = 0;
    let renderedRows = 0;
    let visibleColumns = 0;
    let textRuns = 0;
    let placeholderCells = 0;
    let tables = 0;

    for (const id of this.#core.world.order) {
      const stored = this.#core.world.entities.get(id);
      if (stored === undefined) continue;
      const entity = this.drawnEntity(stored);
      // The halo hangs above the table, so culling allows a margin for it.
      const margin = isEntityActivated(session, entity.id)
        ? (this.theme.haloButtonSize + this.theme.haloOffset) / Math.max(0.05, this.camera.scale)
        : 0;
      // A statistics panel hangs off the table, below it or above it, so a table
      // just past the edge of the view can still have something on screen.
      const panelMargin =
        pickedColumns !== null && entity.columns.some((column) => pickedColumns.has(column.id))
          ? SUMMARY_PANEL_GAP + SUMMARY_PANEL_MAX_HEIGHT
          : 0;
      const bounds = {
        x: entity.transform.x,
        y: entity.transform.y - margin - panelMargin,
        width: entity.transform.width,
        height: entity.transform.height + margin + panelMargin * 2,
      };
      if (!rectsIntersect(bounds, visibleRect)) {
        /**
         * Culled, but a chart is laid out anyway.
         *
         * Culling is about not drawing, and for a table that is the whole of it:
         * what a table is can be read from the document. A chart is different —
         * what it came out like exists only once it has been laid out, and that is
         * the only feedback there is on a written option. An agent reads it back
         * and cannot move the camera, so a chart parked outside the view reported
         * "not drawn yet" for as long as anybody cared to keep asking. It was a
         * real answer to a question nobody had asked: not *yet* implied waiting
         * would help, and nothing would.
         *
         * Laying it out costs one layout per change rather than one per frame —
         * the host caches by specification, data and size, and this passes the
         * same size the drawing would — so an off-screen chart costs what an
         * on-screen one costs, once.
         */
        if (entity.source.kind === 'chart') this.#chart(entity);
        continue;
      }

      const view = this.#views.viewFor(entity);
      const drawList = buildTableDrawList({
        entity,
        layout: this.layoutFor(entity),
        theme: this.theme,
        lod,
        scrollTop: view?.scrollTop ?? 0,
        scrollLeft: view?.scrollLeft ?? 0,
        // A table whose data session has not opened yet shows empty chrome
        // rather than an unbounded field of placeholders.
        rowCount: view === null ? 0 : view.rowCount,
        data: view?.data ?? EMPTY_DATA,
        selected: selection.has(entity.id),
        hoveredRow: this.#hoveredRow(entity, view),
        gutterWidth: this.#gutterWidth,
        showHalo: isEntityActivated(session, entity.id),
        scale: this.camera.scale,
        ...this.#disabledActions(entity),
        hoveredAction:
          session.hoveredAction?.entityId === entity.id ? session.hoveredAction.action : null,
        pressedAction:
          session.pressedAction?.entityId === entity.id ? session.pressedAction.action : null,
        expandedAction: expandedActionOf(session, entity.id),
        selectedColumns: session.selectedColumns,
        hoveredColumn: session.hoveredColumn,
        ...this.#columnSummaries(entity),
        ...this.#statementNote(entity),
        ...this.#chart(entity),
        ...(panelMargin === 0 ? {} : { panelObstacles: this.#neighbours(entity) }),
      });

      const originX = entity.transform.x;
      const originY = entity.transform.y;
      const z = -entity.transform.z;
      for (const quad of drawList.quads) {
        this.#solid.push(
          originX + quad.x,
          toBabylonY(originY + quad.y),
          z,
          quad.width,
          quad.height,
          quad.color,
        );
      }
      // After the quads, never before: a chart's own marks are polygons and the
      // body background behind them is a quad, so drawing them first would paint
      // the background straight over the picture.
      for (const polygon of drawList.polygons) {
        this.#pushWorldPolygon({
          corners: [
            originX + (polygon.corners[0] as number),
            originY + (polygon.corners[1] as number),
            originX + (polygon.corners[2] as number),
            originY + (polygon.corners[3] as number),
            originX + (polygon.corners[4] as number),
            originY + (polygon.corners[5] as number),
            originX + (polygon.corners[6] as number),
            originY + (polygon.corners[7] as number),
          ],
          color: polygon.color,
        });
      }
      for (const run of drawList.texts) {
        for (const glyph of this.text.layout(run).quads) {
          this.#glyphs.push(
            originX + glyph.x,
            toBabylonY(originY + glyph.y),
            z,
            glyph.width,
            glyph.height,
            glyph.color,
            [glyph.u0, glyph.v0, glyph.u1, glyph.v1],
          );
        }
      }

      tables += 1;
      visibleRows += drawList.stats.visibleRows;
      renderedRows += drawList.stats.renderedRows;
      visibleColumns += drawList.stats.visibleColumns;
      textRuns += drawList.stats.textRuns;
      placeholderCells += drawList.stats.placeholderCells;
    }

    // Markers last: an expanded one must not disappear behind a table.
    for (const marker of markers) {
      for (const polygon of marker.polygons) this.#pushWorldPolygon(polygon);
      for (const run of marker.texts) this.#pushWorldText(run);
      textRuns += marker.texts.length;
    }

    this.#solid.commit();
    this.#glyphs.commit();
    if (this.#atlas.version !== this.#atlasVersion) {
      this.#atlasVersion = this.#atlas.version;
      this.#textSystem.upload();
    }

    this.#stats.endFrame(
      {
        tables,
        connectors,
        visibleRows,
        renderedRows,
        visibleColumns,
        quads: this.#solid.quadCount,
        glyphs: this.#glyphs.quadCount,
        textRuns,
        placeholderCells,
      },
      // Two batches plus, at most, one clear.
      this.#solid.quadCount > 0 || this.#glyphs.quadCount > 0 ? 2 : 0,
    );
  }

  /**
   * Builds a frame *and puts it on the screen*.
   *
   * `renderFrame` only fills the vertex buffers; nothing reaches the drawing
   * buffer until the scene is rendered. The two belong together everywhere
   * except in tests, which check the draw list rather than the pixels — so this
   * is what the render loop calls, and what anyone who needs a frame *now*
   * calls. Resizing needs exactly that: assigning `canvas.width` empties the
   * drawing buffer, and an empty buffer that is composited before the next
   * frame is drawn is a flash of nothing.
   */
  draw(deltaMs = 0): void {
    this.renderFrame(deltaMs);
    this.scene.scene.render();
  }

  /**
   * Starts the render loop.
   *
   * A frame that throws is reported once and then stops the loop: a renderer
   * that silently fails every frame looks exactly like an application that
   * ignores its input, which is the worst possible way to fail.
   */
  start(onFrameError?: (error: unknown) => void): void {
    if (this.#running) return;
    this.#running = true;
    const engine = this.scene.scene.getEngine();
    engine.runRenderLoop(() => {
      try {
        this.draw(engine.getDeltaTime());
      } catch (error) {
        this.stop();
        onFrameError?.(error);
      }
    });
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.scene.scene.getEngine().stopRenderLoop();
  }

  /**
   * The WebXR architecture smoke test: the same scene, the same table
   * renderer, viewed through an XR camera. Interaction is rudimentary by
   * design; what is being validated is that nothing depends on the DOM.
   */
  /**
   * Builds the XR experience and reports whether immersive VR is on offer.
   *
   * Separate from entering, and worth calling early, because `requestSession`
   * needs transient user activation: loading the XR chunk and probing support
   * inside the button's own click can outlast the activation window and have
   * the session refused. Warmed up here, the click is a single call.
   *
   * The answer is cached — support does not change while the page is open.
   */
  async prepareXR(): Promise<boolean> {
    const known = this.#xrSupported;
    if (known !== null) return known;
    try {
      const { WebXRDefaultExperience } =
        await import('@babylonjs/core/XR/webXRDefaultExperience.js');
      const { WebXRState } = await import('@babylonjs/core/XR/webXRTypes.js');
      const experience = await WebXRDefaultExperience.CreateAsync(this.scene.scene, {
        // Panorama drives its own entry, so no injected HTML button.
        disableDefaultUI: true,
        // The panel is a fixed screen in front of the viewer, not a place to
        // walk around in.
        disableTeleportation: true,
        // Every quad is `isPickable = false` — the batches are one mesh each,
        // so a ray could only ever hit "the table layer", never a cell. Left
        // on, these features also drag in optional modules that are not
        // registered under deep ES imports, and Babylon fails the whole
        // initialisation with "feature not found".
        disablePointerSelection: true,
        disableNearInteraction: true,
        disableHandTracking: true,
        /**
         * Controller profiles come from what is bundled, not from the internet.
         *
         * Babylon otherwise fetches a profile list from a third-party host the
         * moment the experience is built — which is every page load, since this
         * runs early to keep the entry click inside its activation window. In an
         * installed application that is a request to somebody else's server
         * before anything has been asked for, and it fails outright with no
         * network: the installability probe found it exactly that way.
         *
         * Nothing visible is given up here. Pointer selection and near
         * interaction are off, so a controller is a pose and a button rather than
         * something to aim; the locally defined profiles cover that, at the cost
         * of a generic mesh where an exact model of somebody's controller would
         * otherwise have been drawn.
         */
        inputOptions: { disableOnlineControllerRepository: true },
      });
      const base = experience.baseExperience;
      // Babylon resolves even where WebXR is unavailable, leaving no base
      // experience behind; report that as "not on offer".
      if (base === undefined) {
        this.#xrSupported = false;
        return false;
      }
      const supported = await base.sessionManager.isSessionSupportedAsync(XR_SESSION_MODE);
      this.#xrSupported = supported;
      if (!supported) return false;
      // Taking the headset off puts the world back on the desk at its own size.
      base.onStateChangedObservable.add((state) => {
        if (state === WebXRState.NOT_IN_XR) this.#stage.reset();
      });
      this.#xr = experience;
      return true;
    } catch {
      this.#xrSupported = false;
      return false;
    }
  }

  /**
   * Enters immersive VR.
   *
   * Creating the experience is not entering it — Babylon builds the helper and
   * waits to be asked — so this asks, having first shrunk the world to human
   * scale. Resolves to `null` where immersive VR is not on offer.
   */
  async enterXR(): Promise<WebXRDefaultExperience | null> {
    if (!(await this.prepareXR())) return null;
    const experience = this.#xr;
    if (experience?.baseExperience === undefined) return null;
    // The camera keeps its place: whatever was on the canvas is what stands in
    // front of the viewer in the headset.
    const view = this.camera.visibleWorldRect();
    this.#stage.place({ x: view.x + view.width / 2, y: view.y + view.height / 2 });
    try {
      // `local-floor` puts the origin on the floor, which is what the panel's
      // height is measured from.
      await experience.baseExperience.enterXRAsync(XR_SESSION_MODE, 'local-floor');
    } catch {
      this.#stage.reset();
      return null;
    }
    return experience;
  }

  /** True while the world is shrunk onto the XR panel. */
  get inXR(): boolean {
    return this.#stage.placed;
  }

  dispose(): void {
    this.stop();
    this.#stage.dispose();
    this.#solid.dispose();
    this.#glyphs.dispose();
    this.#textSystem.dispose();
    this.scene.dispose();
  }
}
