import type { EntityId, TableEntity } from '@panorama/core';
import { ROW_NUMBER_GUTTER_WIDTH } from '@panorama/core';
import type { CellValue, ColumnLayout, TableSchema, TableViewport } from '@panorama/table';
import {
  SmoothScroll,
  VelocityTracker,
  computeColumnLayout,
  computeRowWindow,
  sameDataRequirements,
} from '@panorama/table';
import type { TableMetrics, TableTheme } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  maxScrollLeftOf,
  maxScrollTopOf,
  tableMetrics,
} from '@panorama/renderer';
import type { CompiledStatement, TableDataGateway, TableOpenSpec } from '@panorama/worker';
import { TableDataController } from '@panorama/worker';

/**
 * Everything one open table needs on the render thread: scroll state, scroll
 * smoothing, velocity, and the bounded row cache behind its data controller.
 *
 * Renderer state only. None of it belongs in the document, and none of it is
 * ever recorded in history.
 */

export interface TableViewOptions {
  readonly tableId: EntityId;
  readonly gateway: TableDataGateway;
  readonly blockSize?: number;
  readonly maxBytes?: number;
  readonly onChange?: () => void;
  readonly rowOverscan?: number;
  readonly gutterWidth?: number;
  readonly theme?: TableTheme;
}

export const DEFAULT_ROW_OVERSCAN = 6;

export class TableView {
  readonly tableId: EntityId;
  readonly controller: TableDataController;
  readonly vertical = new SmoothScroll();
  readonly horizontal = new SmoothScroll();
  readonly #velocity = new VelocityTracker();
  readonly #rowOverscan: number;
  readonly #gutterWidth: number;
  readonly #theme: TableTheme;
  #layout: ColumnLayout = { placements: [], totalWidth: 0 };
  #layoutSource: readonly unknown[] | null = null;
  #lastViewport: TableViewport | null = null;

  constructor(options: TableViewOptions) {
    this.tableId = options.tableId;
    this.#rowOverscan = options.rowOverscan ?? DEFAULT_ROW_OVERSCAN;
    this.#gutterWidth = options.gutterWidth ?? ROW_NUMBER_GUTTER_WIDTH;
    this.#theme = options.theme ?? DEFAULT_TABLE_THEME;
    this.controller = new TableDataController({
      tableId: options.tableId,
      gateway: options.gateway,
      ...(options.blockSize === undefined ? {} : { blockSize: options.blockSize }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
    });
  }

  get schema(): TableSchema | null {
    return this.controller.schema;
  }

  get rowCount(): number | null {
    return this.controller.rowCount;
  }

  /** The physical SQL behind these rows, where a semantic layer compiled them. */
  get compiled(): CompiledStatement | null {
    return this.controller.compiled;
  }

  get scrollTop(): number {
    return this.vertical.current;
  }

  get scrollLeft(): number {
    return this.horizontal.current;
  }

  get layout(): ColumnLayout {
    return this.#layout;
  }

  get velocityY(): number {
    return this.#velocity.velocity;
  }

  /** Returns the schema the result set reported, which a query only learns here. */
  async open(spec: TableOpenSpec): Promise<TableSchema> {
    return this.controller.open(spec);
  }

  /** Reopens the result set after a reconnect and returns to the top. */
  async reopen(): Promise<void> {
    await this.controller.reopen();
    this.vertical.jumpTo(0);
    this.horizontal.jumpTo(0);
    this.#lastViewport = null;
  }

  /** Scrolls by a pixel delta. The viewport moves this frame, regardless of data. */
  scrollBy(deltaX: number, deltaY: number, timestampMs: number): void {
    if (deltaY !== 0) {
      this.vertical.scrollBy(deltaY);
      this.#velocity.sample(deltaY, timestampMs);
    }
    if (deltaX !== 0) this.horizontal.scrollBy(deltaX);
  }

  scrollToFraction(axis: 'vertical' | 'horizontal', fraction: number, entity: TableEntity): void {
    const metrics = this.#applyBounds(entity);
    if (axis === 'vertical') this.vertical.jumpTo(maxScrollTopOf(metrics) * fraction);
    else this.horizontal.jumpTo(maxScrollLeftOf(metrics) * fraction);
  }

  /** Recomputes the column layout when the columns change. */
  layoutFor(entity: TableEntity): ColumnLayout {
    if (this.#layoutSource !== entity.columns) {
      this.#layout = computeColumnLayout(entity.columns);
      this.#layoutSource = entity.columns;
    }
    return this.#layout;
  }

  /** The same geometry the renderer and hit testing use. */
  metricsFor(entity: TableEntity): TableMetrics {
    return tableMetrics(
      entity,
      this.layoutFor(entity),
      this.controller.rowCount,
      this.#theme,
      this.#gutterWidth,
    );
  }

  #applyBounds(entity: TableEntity): TableMetrics {
    const metrics = this.metricsFor(entity);
    this.vertical.setBounds(0, maxScrollTopOf(metrics));
    this.horizontal.setBounds(0, maxScrollLeftOf(metrics));
    return metrics;
  }

  /**
   * Advances one frame: eases the scroll, decays the velocity, and tells the
   * worker what is wanted — but only when the requirement actually changed, so
   * a smooth scroll does not produce a message per frame.
   */
  update(entity: TableEntity, deltaMs: number, timestampMs: number): void {
    const metrics = this.#applyBounds(entity);
    this.vertical.update(deltaMs);
    this.horizontal.update(deltaMs);
    if (this.vertical.settled) this.#velocity.idle(timestampMs);

    const rows = computeRowWindow({
      scrollTop: this.vertical.current,
      rowHeight: metrics.rowHeight,
      bodyHeight: metrics.bodyHeight,
      rowCount: this.controller.rowCount,
      overscan: this.#rowOverscan,
    });
    const viewport: TableViewport = {
      firstVisibleRow: rows.firstVisibleRow,
      visibleRowCount: rows.visibleRowCount,
      firstVisibleColumn: 0,
      visibleColumns: [],
      verticalPixelOffset: this.vertical.current,
      horizontalPixelOffset: this.horizontal.current,
      velocityY: this.#velocity.velocity,
    };
    if (this.#lastViewport !== null && sameDataRequirements(this.#lastViewport, viewport)) return;
    this.#lastViewport = viewport;
    this.controller.setViewport({
      firstVisibleRow: rows.firstVisibleRow,
      visibleRowCount: rows.visibleRowCount,
      velocityY: this.#velocity.velocity,
    });
  }

  cell(row: number, columnIndex: number): CellValue | undefined {
    return this.controller.cell(row, columnIndex);
  }

  async close(): Promise<void> {
    await this.controller.close();
  }
}
