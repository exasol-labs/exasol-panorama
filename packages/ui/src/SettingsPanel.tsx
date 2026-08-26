import { useCallback, useEffect, useState } from 'react';

/**
 * Settings, which so far is one thing: the agent interface, and getting Claude
 * onto the other end of it.
 *
 * It exists because the last mile of that was a paragraph in a README — which
 * client, told about which endpoint, and is anything actually talking. The
 * machine can answer all three, so it is asked, and the answers are on screen
 * next to the buttons that change them.
 *
 * Everything here is a request to the development server that is serving this
 * page: it is the one process in a position to look for Claude on this machine
 * and to start it. In a build those routes do not exist, and the panel says the
 * agent interface is not available rather than pretending otherwise.
 */

export interface AgentHealth {
  readonly attached: number;
  readonly calls: number;
  readonly lastCallAt: number | null;
  readonly mcpUrl: string;
  readonly tools: readonly string[];
}

export interface ClaudeStatusView {
  readonly platform: string;
  readonly cli: { readonly found: boolean; readonly path?: string; readonly paired: boolean };
  readonly desktop: {
    readonly found: boolean;
    readonly configPath: string;
    readonly paired: boolean;
  };
  readonly canOpenTerminal: boolean;
  readonly mcpUrl: string;
}

export interface SettingsPanelProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Reads a route on the development server; `null` when it is not there. */
  readonly load: <TValue>(path: string) => Promise<TValue | null>;
  /** Asks the development server to do something, and reports what happened. */
  readonly act: <TValue>(path: string, body: unknown) => Promise<TValue | null>;
  /** For the clipboard, which the shell owns because a page may not have one. */
  readonly onCopy?: (text: string) => void;
}

const GEAR = (
  <svg
    viewBox="0 0 16 16"
    width={14}
    height={14}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.3}
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="8" cy="8" r="2.3" />
    <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
  </svg>
);

/** How long ago something happened, in the roughest terms that are still true. */
const ago = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

export const SettingsPanel = ({
  open,
  onToggle,
  load,
  act,
  onCopy,
}: SettingsPanelProps): React.JSX.Element => {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [claude, setClaude] = useState<ClaudeStatusView | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<readonly string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    const [nextHealth, nextClaude] = await Promise.all([
      load<AgentHealth>('/agent/health'),
      load<ClaudeStatusView>('/agent/claude'),
    ]);
    setHealth(nextHealth);
    setClaude(nextClaude);
    setAvailable(nextHealth !== null);
  }, [load]);

  /**
   * Read while the panel is open, and again on a slow tick: "is anything talking
   * to it" is a question whose answer changes without anybody pressing anything.
   */
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return (): void => {
      clearInterval(timer);
    };
  }, [open, refresh]);

  const run = useCallback(
    async (path: string, body: unknown): Promise<void> => {
      setBusy(true);
      setSaid([]);
      const answer = await act<{
        outcomes?: readonly { detail: string }[];
        detail?: string;
        error?: string;
      }>(path, body);
      setBusy(false);
      const lines =
        answer === null
          ? ['The development server did not answer.']
          : (answer.outcomes?.map((outcome) => outcome.detail) ?? [
              answer.detail ?? answer.error ?? 'Done.',
            ]);
      setSaid(lines);
      await refresh();
    },
    [act, refresh],
  );

  return (
    <section className="pn-panel pn-settings">
      <div className="pn-panel__heading">
        <h2 className="pn-panel__title">Settings</h2>
        <button
          type="button"
          className="pn-settings__gear"
          aria-expanded={open}
          aria-label={open ? 'Hide settings' : 'Show settings'}
          onClick={onToggle}
        >
          {GEAR}
        </button>
      </div>

      {!open ? null : !available ? (
        <p className="pn-hint">
          The agent interface is part of the development server. Run <code>npm run dev</code> to
          have it.
        </p>
      ) : (
        <>
          <div className="pn-settings__row">
            <span className="pn-settings__label">Agent endpoint</span>
            {/* Truncated to fit, so the whole of it is the tooltip as well. */}
            <code className="pn-settings__value" title={health?.mcpUrl ?? ''}>
              {health?.mcpUrl ?? '—'}
            </code>
            {onCopy === undefined || health === null ? null : (
              <button type="button" onClick={() => onCopy(health.mcpUrl)}>
                Copy
              </button>
            )}
          </div>
          <p className="pn-hint">
            {health === null
              ? ''
              : `${health.tools.length} tools · this page ${health.attached > 0 ? 'attached' : 'not attached'} · ${
                  health.calls === 0
                    ? 'nothing has asked yet'
                    : `${health.calls} call${health.calls === 1 ? '' : 's'}, last ${ago(Date.now() - (health.lastCallAt ?? 0))}`
                }`}
          </p>

          <div className="pn-settings__row">
            <span className="pn-settings__label">Claude Code</span>
            <span className="pn-settings__value">
              {claude === null
                ? 'unknown'
                : !claude.cli.found
                  ? 'not on this machine'
                  : claude.cli.paired
                    ? 'paired'
                    : 'found, not paired'}
            </span>
          </div>
          <div className="pn-settings__row">
            <span className="pn-settings__label">Claude desktop</span>
            <span className="pn-settings__value">
              {claude === null
                ? 'unknown'
                : !claude.desktop.found
                  ? 'not on this machine'
                  : claude.desktop.paired
                    ? 'paired'
                    : 'found, not paired'}
            </span>
          </div>

          <div className="pn-field pn-field--row">
            <button
              type="button"
              disabled={busy || claude === null || (!claude.cli.found && !claude.desktop.found)}
              onClick={() => void run('/agent/claude/pair', {})}
            >
              Pair with Claude
            </button>
            {/*
              Named after what it will actually open, which the panel already
              knows: "Open Claude" on a machine with both is a question the
              person pressing it should not have to hold in their head.
            */}
            <button
              type="button"
              disabled={busy || claude === null || (!claude.cli.found && !claude.desktop.found)}
              onClick={() => void run('/agent/claude/open', {})}
            >
              {claude?.desktop.found === true ? 'Open Claude app' : 'Open Claude Code'}
            </button>
          </div>

          {said.length === 0 ? null : (
            <ul className="pn-settings__said" aria-label="What happened">
              {said.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
