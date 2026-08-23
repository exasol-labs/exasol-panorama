import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PerformanceMetrics, TableListing } from '@panorama/ui';
import {
  ConnectionDialog,
  PerformanceOverlay,
  SampleDataPanel,
  SchemaExplorer,
} from '@panorama/ui';
import type { ConnectionRequest, ConnectionStatus, SchemaListing } from '@panorama/ui';
import type { ForeignKeyFollow, FrameStats, PanoramaRenderer } from '@panorama/renderer';
import type { ConnectionId, EntityActionId, EntityId } from '@panorama/core';
import type { CreateEngineOptions } from '@panorama/renderer';
import { PanoramaCanvas } from './panorama/PanoramaCanvas.js';
import { backendOverride } from './bootstrap.js';
import { DEMO_SCHEMA, demoTables } from './panorama/demo.js';
import type { Workspace } from './panorama/workspace.js';

/**
 * The application shell.
 *
 * React owns the conventional UI — connection, explorer, instrumentation — and
 * nothing else. A table moving or scrolling never reaches this component.
 */

export interface AppProps {
  readonly workspace: Workspace;
  readonly defaultUrl?: string;
  readonly engineOptions?: CreateEngineOptions;
}

const EMPTY_METRICS: PerformanceMetrics = {
  fps: 0,
  cpuMs: 0,
  averageCpuMs: 0,
  worstCpuMs: 0,
  drawCalls: 0,
  tables: 0,
  visibleRows: 0,
  renderedRows: 0,
  visibleColumns: 0,
  glyphs: 0,
  placeholderCells: 0,
  cacheBlocks: 0,
  cacheBytes: 0,
  cacheEvictions: 0,
  fetchesPending: 0,
  fetchesCompleted: 0,
  lastFetchMs: 0,
  averageFetchMs: 0,
  backend: '—',
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const App = ({ workspace, defaultUrl, engineOptions }: AppProps): React.JSX.Element => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<readonly SchemaListing[]>([]);
  const [tables, setTables] = useState<readonly TableListing[]>([]);
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [metrics, setMetrics] = useState<PerformanceMetrics>(EMPTY_METRICS);
  const [xrAvailable, setXrAvailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const engine = useMemo<CreateEngineOptions>(() => {
    if (engineOptions !== undefined) return engineOptions;
    const preferWebGPU = backendOverride(globalThis.location?.search ?? '');
    return preferWebGPU === undefined ? {} : { preferWebGPU };
  }, [engineOptions]);

  const statsRef = useRef<FrameStats | null>(null);
  const rendererRef = useRef<PanoramaRenderer | null>(null);
  const backendRef = useRef<string>('—');

  // The overlay samples the render loop rather than the render loop pushing
  // React updates: the frame budget belongs to the GPU, not to reconciliation.
  useEffect(() => {
    const timer = setInterval(() => {
      const stats = statsRef.current;
      const data = workspace.dataMetrics();
      setMetrics({
        ...EMPTY_METRICS,
        ...(stats ?? {}),
        ...data,
        backend: backendRef.current,
      });
    }, 250);
    return (): void => {
      clearInterval(timer);
    };
  }, [workspace]);

  const onReady = useCallback((renderer: PanoramaRenderer, backend: string) => {
    rendererRef.current = renderer;
    backendRef.current = backend;
    setXrAvailable(true);
  }, []);

  const connect = useCallback(
    (request: ConnectionRequest) => {
      setStatus('connecting');
      setConnectionError(null);
      void (async (): Promise<void> => {
        try {
          const result = await workspace.connect(request);
          workspace.connectionId = result.connectionId as ConnectionId;
          setStatus('connected');
          setLoadingSchemas(true);
          setSchemas(await workspace.listSchemas());
        } catch (error) {
          setStatus('failed');
          setConnectionError(describeError(error));
        } finally {
          setLoadingSchemas(false);
        }
      })();
    },
    [workspace],
  );

  const disconnect = useCallback(() => {
    void (async (): Promise<void> => {
      await workspace.closeAll();
      await workspace.disconnect();
      setStatus('disconnected');
      setSchemas([]);
      setTables([]);
      setSelectedSchema(null);
    })();
  }, [workspace]);

  const selectSchema = useCallback(
    (schema: string) => {
      setSelectedSchema(schema);
      setExplorerError(null);
      setLoadingTables(true);
      void (async (): Promise<void> => {
        try {
          setTables(await workspace.listTables(schema));
        } catch (error) {
          setTables([]);
          setExplorerError(describeError(error));
        } finally {
          setLoadingTables(false);
        }
      })();
    },
    [workspace],
  );

  const openTable = useCallback(
    (table: TableListing) => {
      setExplorerError(null);
      void (async (): Promise<void> => {
        try {
          const id = await workspace.openTable({ schema: table.schema, table: table.name });
          rendererRef.current?.revealEntity(id);
        } catch (error) {
          setExplorerError(describeError(error));
        }
      })();
    },
    [workspace],
  );

  const openSample = useCallback(
    (name: string) => {
      setNotice(null);
      void (async (): Promise<void> => {
        try {
          const id = await workspace.openTable({ schema: DEMO_SCHEMA, table: name });
          rendererRef.current?.revealEntity(id);
        } catch (error) {
          setNotice(describeError(error));
        }
      })();
    },
    [workspace],
  );

  const samples = useMemo(() => demoTables(), []);

  const performAction = useCallback(
    (entityId: EntityId, action: EntityActionId) => {
      void (async (): Promise<void> => {
        try {
          await workspace.performAction(entityId, action);
        } catch (error) {
          setNotice(describeError(error));
        }
      })();
    },
    [workspace],
  );

  const followForeignKey = useCallback(
    (follow: ForeignKeyFollow) => {
      setNotice(null);
      void (async (): Promise<void> => {
        try {
          const { tableId } = await workspace.followForeignKey(follow);
          rendererRef.current?.revealEntity(tableId);
        } catch (error) {
          setNotice(describeError(error));
        }
      })();
    },
    [workspace],
  );

  const enterXR = useCallback(() => {
    setNotice(null);
    void (async (): Promise<void> => {
      const entered = await rendererRef.current?.enterXR();
      if (entered === null || entered === undefined) {
        setNotice('WebXR is not available in this browser.');
      }
    })();
  }, []);

  const toggleOverlay = useCallback(() => {
    setOverlayVisible((visible) => !visible);
  }, []);

  const sidebar = useMemo(
    () => (
      <div className="pn-sidebar">
        <ConnectionDialog
          status={status}
          error={connectionError}
          {...(defaultUrl === undefined ? {} : { defaultUrl })}
          onConnect={connect}
          onDisconnect={disconnect}
        />
        {status === 'connected' ? (
          <SchemaExplorer
            schemas={schemas}
            tables={tables}
            selectedSchema={selectedSchema}
            loadingSchemas={loadingSchemas}
            loadingTables={loadingTables}
            error={explorerError}
            onSelectSchema={selectSchema}
            onOpenTable={openTable}
          />
        ) : null}
        <SampleDataPanel tables={samples} onOpen={openSample} />
        {xrAvailable ? (
          <button type="button" className="pn-xr" onClick={enterXR}>
            Enter XR
          </button>
        ) : null}
        {notice !== null ? (
          <p className="pn-error" role="alert">
            {notice}
          </p>
        ) : null}
      </div>
    ),
    [
      status,
      connectionError,
      defaultUrl,
      connect,
      disconnect,
      schemas,
      tables,
      selectedSchema,
      loadingSchemas,
      loadingTables,
      explorerError,
      selectSchema,
      openTable,
      xrAvailable,
      enterXR,
      notice,
      samples,
      openSample,
    ],
  );

  return (
    <div className="pn-app">
      {sidebar}
      <main className="pn-stage">
        <PanoramaCanvas
          workspace={workspace}
          onReady={onReady}
          statsRef={statsRef}
          engineOptions={engine}
          onError={setNotice}
          onAction={performAction}
          onFollowForeignKey={followForeignKey}
        />
        <PerformanceOverlay metrics={metrics} visible={overlayVisible} onToggle={toggleOverlay} />
      </main>
    </div>
  );
};
