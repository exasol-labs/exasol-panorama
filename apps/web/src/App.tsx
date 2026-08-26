import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExportListing, PerformanceMetrics, SchemaContents, TableListing } from '@panorama/ui';
import {
  ConnectionDialog,
  connectionLabel,
  ExportPanel,
  SettingsPanel,
  PerformanceOverlay,
  SampleDataPanel,
  SchemaExplorer,
} from '@panorama/ui';
import type { ConnectionRequest, ConnectionStatus, SchemaListing } from '@panorama/ui';
import type { ForeignKeyFollow, FrameStats, PanoramaRenderer } from '@panorama/renderer';
import type { ConnectionId, EntityActionId, EntityId } from '@panorama/core';
import type { CreateEngineOptions } from '@panorama/renderer';
import { PanoramaCanvas } from './panorama/PanoramaCanvas.js';
import { ChartEditors } from './panorama/ChartEditors.js';
import { SqlEditors } from './panorama/SqlEditors.js';
import { backendOverride } from './bootstrap.js';
import { DEMO_SCHEMA, demoTables } from './panorama/demo.js';
import { describeFormat } from '@panorama/export';
import type { ExportJob, Workspace } from './panorama/workspace.js';
import type { StartupConnection } from './panorama/startup.js';

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
  /** Connection details supplied before the page opened; see `startup.ts`. */
  readonly startup?: StartupConnection | null;
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

export const App = ({
  workspace,
  defaultUrl,
  engineOptions,
  startup = null,
}: AppProps): React.JSX.Element => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  /**
   * The URL of the live connection, for the explorer's indicator.
   *
   * The URL and nothing else: a username is not a secret, but credentials are
   * handed to the data worker and kept nowhere, and the shell holding half of
   * one for a caption would be the first crack in that.
   */
  const [connectedTo, setConnectedTo] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<readonly SchemaListing[]>([]);
  /**
   * What each opened schema holds. A map rather than one selected schema's
   * tables, because the tree can have several open at once — which is the point
   * of it being a tree.
   */
  const [contents, setContents] = useState<ReadonlyMap<string, SchemaContents>>(new Map());
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [metrics, setMetrics] = useState<PerformanceMetrics>(EMPTY_METRICS);
  const [xrAvailable, setXrAvailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exports, setExports] = useState<readonly ExportJob[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  /**
   * Exports live in the workspace, not in this component: one outlives any
   * render, and stopping one has to work even if the panel is redrawn under it.
   * React only mirrors them.
   */
  useEffect(
    () =>
      workspace.subscribeExports(() => {
        setExports(workspace.exportJobs());
      }),
    [workspace],
  );

  const exportListings = useMemo<readonly ExportListing[]>(
    () =>
      exports.map((job: ExportJob) => ({
        id: job.id,
        tableName: job.tableName,
        fileName: job.fileName,
        formatLabel: describeFormat(job.format).label,
        status: job.status,
        rows: job.rows,
        bytes: job.bytes,
        totalRows: job.totalRows,
        ...(job.error === undefined ? {} : { error: job.error }),
      })),
    [exports],
  );

  const cancelExport = useCallback(
    (id: number) => {
      workspace.cancelExport(id);
    },
    [workspace],
  );

  const dismissExport = useCallback(
    (id: number) => {
      workspace.dismissExport(id);
    },
    [workspace],
  );

  const onReady = useCallback(
    (renderer: PanoramaRenderer, backend: string) => {
      rendererRef.current = renderer;
      backendRef.current = backend;
      // Placement needs to know what is on screen, and only the camera does.
      // Handed over here because the renderer does not exist until now.
      workspace.viewport = (): ReturnType<typeof renderer.camera.visibleWorldRect> =>
        renderer.camera.visibleWorldRect();
      // Ask whether a headset is actually on offer rather than assuming one, and
      // warm the XR chunk up now: entering needs a fresh user gesture, so the
      // button's own click has no time to spare for a download.
      void renderer.prepareXR().then(setXrAvailable);
    },
    [workspace],
  );

  /**
   * Reports whether the connection succeeded, so a caller that has more to do
   * once connected — opening the table named at startup — can wait for it. The
   * dialog ignores the result, as a void-returning handler may.
   */
  const connect = useCallback(
    async (request: ConnectionRequest): Promise<boolean> => {
      setStatus('connecting');
      setConnectionError(null);
      try {
        const result = await workspace.connect(request);
        workspace.connectionId = result.connectionId as ConnectionId;
        setStatus('connected');
        setConnectedTo(request.url);
        setLoadingSchemas(true);
        setSchemas(await workspace.listSchemas());
        return true;
      } catch (error) {
        setStatus('failed');
        setConnectionError(describeError(error));
        return false;
      } finally {
        setLoadingSchemas(false);
      }
    },
    [workspace],
  );

  const disconnect = useCallback(() => {
    void (async (): Promise<void> => {
      await workspace.closeAll();
      await workspace.disconnect();
      setStatus('disconnected');
      setConnectedTo(null);
      setSchemas([]);
      setContents(new Map());
    })();
  }, [workspace]);

  /**
   * Lists a schema the tree has just opened.
   *
   * Skipped when it is already listed: the tree reports every opening, and
   * re-querying a schema the user is merely folding back open would be a query
   * for nothing. A schema that *failed* is retried, so closing and opening it
   * again is the retry.
   */
  const expandSchema = useCallback(
    (schema: string) => {
      if (contents.get(schema)?.status === 'ready') return;
      setContents((held) => new Map(held).set(schema, { status: 'loading' }));
      void (async (): Promise<void> => {
        try {
          const tables = await workspace.listTables(schema);
          setContents((held) => new Map(held).set(schema, { status: 'ready', tables }));
        } catch (error) {
          setContents((held) =>
            new Map(held).set(schema, { status: 'failed', error: describeError(error) }),
          );
        }
      })();
    },
    [workspace, contents],
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

  /**
   * Connects with details supplied before the page opened, and opens the table
   * they name. Runs once: a failure is reported and left alone rather than
   * retried, so a wrong password does not hammer the database.
   */
  const attempted = useRef(false);
  useEffect(() => {
    if (startup === null || !startup.autoConnect || attempted.current) return;
    const credentials = startup.credentials;
    if (credentials === undefined) return;
    attempted.current = true;
    void (async (): Promise<void> => {
      const connected = await connect({ url: startup.url, credentials });
      const open = startup.open;
      if (!connected || open === undefined) return;
      try {
        const id = await workspace.openTable({ schema: open.schema, table: open.table });
        rendererRef.current?.revealEntity(id);
      } catch (error) {
        setExplorerError(describeError(error));
      }
    })();
  }, [startup, connect, workspace]);

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
        setNotice(
          globalThis.isSecureContext === false
            ? 'WebXR needs a secure page. Open Panorama over HTTPS (see npm run dev:vr).'
            : 'WebXR could not start a session in this browser.',
        );
      }
    })();
  }, []);

  const toggleOverlay = useCallback(() => {
    setOverlayVisible((visible) => !visible);
  }, []);

  const toggleSettings = useCallback(() => {
    setSettingsOpen((shown) => !shown);
  }, []);

  /**
   * The settings panel's window onto the development server.
   *
   * Held here rather than in the panel so that the panel needs no network of its
   * own: it asks for a path and is given an answer or a `null`, and `null` is
   * what a built page — where these routes do not exist — will always get.
   */
  const loadSetting = useCallback(async <TValue,>(path: string): Promise<TValue | null> => {
    try {
      const response = await fetch(path);
      return response.ok ? ((await response.json()) as TValue) : null;
    } catch {
      return null;
    }
  }, []);

  const actSetting = useCallback(
    async <TValue,>(path: string, body: unknown): Promise<TValue | null> => {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return (await response.json()) as TValue;
      } catch {
        return null;
      }
    },
    [],
  );

  const copyText = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  const sidebar = useMemo(
    () => (
      <div className="pn-sidebar">
        {/*
          The dialog is a question, so it goes once it has been answered: every
          field in it is disabled while connected, and a form that can only be
          read is a quarter of the sidebar spent saying "connected". What is
          worth saying then is said by the explorer's indicator, which is also
          the way back to this form.
        */}
        {status === 'connected' ? (
          <SchemaExplorer
            schemas={schemas}
            connection={{
              label: connectionLabel(connectedTo ?? ''),
              ...(connectedTo === null ? {} : { detail: connectedTo }),
              onDisconnect: disconnect,
            }}
            contents={contents}
            loadingSchemas={loadingSchemas}
            error={explorerError}
            onExpandSchema={expandSchema}
            onOpenTable={openTable}
          />
        ) : (
          <ConnectionDialog
            status={status}
            error={connectionError}
            {...(startup?.url === undefined
              ? defaultUrl === undefined
                ? {}
                : { defaultUrl }
              : { defaultUrl: startup.url })}
            {...(startup?.username === undefined ? {} : { defaultUsername: startup.username })}
            onConnect={connect}
          />
        )}
        <SampleDataPanel tables={samples} onOpen={openSample} />
        <ExportPanel exports={exportListings} onCancel={cancelExport} onDismiss={dismissExport} />
        <SettingsPanel
          open={settingsOpen}
          onToggle={toggleSettings}
          load={loadSetting}
          act={actSetting}
          onCopy={copyText}
        />
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
      connectedTo,
      connectionError,
      defaultUrl,
      connect,
      disconnect,
      schemas,
      contents,
      loadingSchemas,
      explorerError,
      expandSchema,
      openTable,
      xrAvailable,
      enterXR,
      notice,
      samples,
      openSample,
      exportListings,
      cancelExport,
      dismissExport,
      settingsOpen,
      toggleSettings,
      loadSetting,
      actSetting,
      copyText,
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
        <SqlEditors workspace={workspace} rendererRef={rendererRef} onError={setNotice} />
        <ChartEditors workspace={workspace} rendererRef={rendererRef} onError={setNotice} />
        <PerformanceOverlay metrics={metrics} visible={overlayVisible} onToggle={toggleOverlay} />
      </main>
    </div>
  );
};
