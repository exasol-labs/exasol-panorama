/**
 * UI-facing types.
 *
 * The React shell deliberately does not depend on the Exasol driver or on
 * Babylon: it receives plain data and reports intents. That keeps the
 * dependency direction pointing at Panorama Core rather than at the UI.
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface PasswordCredentials {
  readonly kind: 'password';
  readonly username: string;
  readonly password: string;
}

export interface TokenCredentials {
  readonly kind: 'token';
  readonly token: string;
}

export type ConnectionCredentials = PasswordCredentials | TokenCredentials;

export interface ConnectionRequest {
  readonly url: string;
  readonly credentials: ConnectionCredentials;
}

export interface SchemaListing {
  readonly name: string;
}

export interface TableListing {
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly comment?: string;
  /** Rows the database's catalogue reports; absent where it has no figure. */
  readonly rowCount?: number;
}

/**
 * Everything the development overlay displays. Plain numbers, so the overlay
 * has no idea which renderer or data source produced them.
 */
export interface PerformanceMetrics {
  readonly fps: number;
  readonly cpuMs: number;
  readonly averageCpuMs: number;
  readonly worstCpuMs: number;
  readonly drawCalls: number;
  readonly tables: number;
  readonly visibleRows: number;
  readonly renderedRows: number;
  readonly visibleColumns: number;
  readonly glyphs: number;
  readonly placeholderCells: number;
  readonly cacheBlocks: number;
  readonly cacheBytes: number;
  readonly cacheEvictions: number;
  readonly fetchesPending: number;
  readonly fetchesCompleted: number;
  readonly lastFetchMs: number;
  readonly averageFetchMs: number;
  readonly backend: string;
}
