import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@panorama/core';
import { derivedTableRanges, isTableEntity } from '@panorama/core';
import { DEFAULT_TABLE_THEME } from '@panorama/renderer';
import type { PanoramaRenderer } from '@panorama/renderer';
import type { Workspace } from './workspace.js';

/**
 * The editable surface of a query box.
 *
 * This is the one place Panorama puts DOM on top of the canvas, and it is a
 * deliberate exception. Text entry is not a rectangle and a caret: it is
 * selection, IME composition, native undo, autorepeat, screen readers and every
 * platform keybinding a user already knows. A GPU text editor would reimplement
 * all of that, worse. So a real `<textarea>` is positioned over the box while
 * the statement is being written, and the box's GPU rendering — which is what
 * XR and screenshots see — draws the same statement underneath.
 *
 * Nothing here re-renders per frame: the element list only changes when a box
 * opens or closes, and following the camera is done by writing `style` directly
 * from an animation frame.
 */

export interface SqlEditorsProps {
  readonly workspace: Workspace;
  readonly rendererRef: { current: PanoramaRenderer | null };
  readonly onError: (message: string | null) => void;
}

/** Below this zoom the box is too small to type in, so the editor steps aside. */
const MIN_LEGIBLE_SCALE = 0.35;

const sameIds = (left: readonly EntityId[], right: readonly EntityId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const SqlEditors = ({
  workspace,
  rendererRef,
  onError,
}: SqlEditorsProps): React.JSX.Element => {
  const [ids, setIds] = useState<readonly EntityId[]>([]);
  const elements = useRef(new Map<EntityId, HTMLDivElement>());

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      const editing = workspace.editingQueryTables();
      setIds((current) => (sameIds(current, editing) ? current : editing));

      const renderer = rendererRef.current;
      if (renderer === null) return;
      const { camera } = renderer;
      const scale = camera.scale;
      for (const [id, element] of elements.current) {
        const entity = workspace.core.world.entities.get(id);
        if (entity === undefined || !isTableEntity(entity)) continue;
        // The *drawn* transform, not the committed one. A drag lives in session
        // state and is only committed on release, so reading `entity.transform`
        // would pin the field where the box used to be and snap it into place at
        // the end — which is exactly what dragging felt like.
        const { x, y, width, height } = renderer.drawnEntity(entity).transform;
        // The editor covers the body only; the title bar stays the renderer's,
        // so dragging a box by its title still works while it is being edited.
        const top = y + DEFAULT_TABLE_THEME.titleHeight;
        const origin = camera.worldToScreen(x, top);
        element.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
        element.style.width = `${width * scale}px`;
        element.style.height = `${(height - DEFAULT_TABLE_THEME.titleHeight) * scale}px`;
        element.style.fontSize = `${DEFAULT_TABLE_THEME.editorFontSize * scale}px`;
        element.style.visibility = scale < MIN_LEGIBLE_SCALE ? 'hidden' : 'visible';
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [workspace, rendererRef]);

  const run = useCallback(
    (tableId: EntityId) => {
      onError(null);
      void (async (): Promise<void> => {
        try {
          await workspace.runQuery(tableId);
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [workspace, onError],
  );

  return (
    <>
      {ids.map((id) => (
        <SqlEditor key={id} tableId={id} workspace={workspace} elements={elements} onRun={run} />
      ))}
    </>
  );
};

interface SqlEditorProps {
  readonly tableId: EntityId;
  readonly workspace: Workspace;
  readonly elements: { current: Map<EntityId, HTMLDivElement> };
  readonly onRun: (tableId: EntityId) => void;
}

/** One stretch of a statement, and whether it names the box's input. */
interface SqlPart {
  readonly text: string;
  readonly reference: boolean;
}

/** Cuts a statement at its references, so each part can be coloured or not. */
export const splitSqlReferences = (sql: string): readonly SqlPart[] => {
  const parts: SqlPart[] = [];
  let last = 0;
  for (const range of derivedTableRanges(sql)) {
    if (range.from > last) parts.push({ text: sql.slice(last, range.from), reference: false });
    parts.push({ text: sql.slice(range.from, range.to), reference: true });
    last = range.to;
  }
  if (last < sql.length) parts.push({ text: sql.slice(last), reference: false });
  return parts;
};

const SqlEditor = ({ tableId, workspace, elements, onRun }: SqlEditorProps): React.JSX.Element => {
  const [sql, setSql] = useState(() => workspace.queryDraft(tableId));
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLPreElement | null>(null);
  const parts = useMemo(() => splitSqlReferences(sql), [sql]);

  /** Keeps the colouring under the text it colours as the field scrolls. */
  const syncScroll = useCallback(() => {
    const area = areaRef.current;
    const backdrop = backdropRef.current;
    if (area === null || backdrop === null) return;
    backdrop.scrollTop = area.scrollTop;
    backdrop.scrollLeft = area.scrollLeft;
  }, []);

  const register = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) elements.current.delete(tableId);
      else elements.current.set(tableId, element);
    },
    [elements, tableId],
  );

  // A box that just opened should be ready to type into.
  useEffect(() => {
    areaRef.current?.focus();
    areaRef.current?.setSelectionRange(sql.length, sql.length);
    // Intentionally once per box: refocusing on every keystroke would fight
    // with the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setSql(event.target.value);
      workspace.setQueryDraft(tableId, event.target.value);
      syncScroll();
    },
    [workspace, tableId, syncScroll],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onRun(tableId);
        return;
      }
      if (event.key === 'Escape' && workspace.hasQueryResult(tableId)) {
        // Abandoning an edit shows the result the box already had; it does not
        // run what is in the field.
        event.preventDefault();
        event.stopPropagation();
        workspace.showQueryResult(tableId);
      }
    },
    [workspace, tableId, onRun],
  );

  return (
    <div className="pn-sql-editor" ref={register}>
      <div className="pn-sql-field">
        {/*
          The colouring is a second copy of the same text sitting exactly behind
          a textarea whose own glyphs are transparent. It is the only way to
          colour part of what someone is typing without giving up a real text
          field — and giving that up would mean giving up selection, IME
          composition, native undo and every keybinding the user already knows.
        */}
        <pre className="pn-sql-backdrop" ref={backdropRef} aria-hidden="true">
          {parts.map((part, index) =>
            part.reference ? (
              // eslint-disable-next-line react/no-array-index-key
              <mark key={index} className="pn-sql-reference">
                {part.text}
              </mark>
            ) : (
              // eslint-disable-next-line react/no-array-index-key
              <span key={index}>{part.text}</span>
            ),
          )}
          {/* A trailing newline is not a line until something follows it. */}
          {'\n'}
        </pre>
        <textarea
          ref={areaRef}
          className="pn-sql-input"
          value={sql}
          spellCheck={false}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          aria-label="SQL statement"
        />
      </div>
      <div className="pn-sql-actions">
        <span className="pn-sql-hint">{DEFAULT_TABLE_THEME.editorHint}</span>
        <button type="button" className="pn-button" onClick={() => onRun(tableId)}>
          Run
        </button>
      </div>
    </div>
  );
};
