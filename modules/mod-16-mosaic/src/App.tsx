import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Catalogue } from './api';
import { Login } from './components/Login';
import { Board } from './components/Board';
import { PaneFrame } from './components/PaneFrame';
import { PanePicker } from './components/PanePicker';
import type { Board as BoardModel, PanePlacement } from '../shared/types';

/**
 * The Mosaic: boards of panes, each pane a whole module.
 *
 * Deliberately thin. There is no data-loading loop, no polling and no refresh
 * cycle, because this module displays nothing of its own — every pane is a live
 * application in a frame, keeping itself current the way it always did. What
 * this component owns is the arrangement: which board, which panes, and where.
 */
export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [bootError, setBootError] = useState('');

  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [me, setMe] = useState('');
  const [boards, setBoards] = useState<BoardModel[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const guard = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && err.status === 401) {
        setLoggedOut(true);
        return;
      }
      say(err instanceof ApiError ? err.message : fallback, true);
    },
    [say],
  );

  const loadBoards = useCallback(async () => {
    const { boards: rows, preferences } = await api.boards();
    setBoards(rows);
    setActiveId((current) => {
      if (current !== null && rows.some((b) => b.id === current)) return current;
      const preferred = preferences.active_board;
      if (preferred !== null && rows.some((b) => b.id === preferred)) return preferred;
      return rows[0]?.id ?? null;
    });
  }, []);

  const boot = useCallback(async () => {
    try {
      setBootError('');
      const { username } = await api.me();
      setMe(username);
      setLoggedOut(false);
      const [cat] = await Promise.all([api.catalogue(), loadBoards()]);
      setCatalogue(cat);
      setReady(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setLoggedOut(true);
        return;
      }
      // Never re-thrown into a floating promise: that leaves the screen on
      // LOADING… for ever with nothing said and nothing to click.
      setBootError(err instanceof Error ? err.message : 'Something went wrong starting the board');
    }
  }, [loadBoards]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const active = boards.find((b) => b.id === activeId) ?? null;

  const addPane = useCallback(
    async (moduleId: string) => {
      if (!active) return;
      try {
        await api.addPane(active.id, moduleId);
        await loadBoards();
        setPicking(false);
      } catch (err) {
        guard(err, 'Could not add that module');
      }
    },
    [active, guard, loadBoards],
  );

  const removePane = useCallback(
    async (paneId: number) => {
      if (!active) return;
      try {
        await api.removePane(active.id, paneId);
        await loadBoards();
      } catch (err) {
        guard(err, 'Could not remove that pane');
      }
    },
    [active, guard, loadBoards],
  );

  const saveLayout = useCallback(
    async (placements: PanePlacement[]) => {
      if (!active) return;
      try {
        await api.saveLayout(active.id, placements);
        await loadBoards();
      } catch (err) {
        guard(err, 'Could not save the arrangement');
      }
    },
    [active, guard, loadBoards],
  );

  if (loggedOut) return <Login onSuccess={() => void boot()} />;
  if (!ready && bootError) {
    return (
      <div className="boot mono">
        <p className="boot__error">{bootError}</p>
        <button className="btn btn--primary" onClick={() => void boot()}>
          TRY AGAIN
        </button>
      </div>
    );
  }
  if (!ready) return <div className="boot mono">LOADING…</div>;

  const moduleOf = (id: string) => catalogue?.modules.find((m) => m.id === id);

  return (
    <div className="ws">
      <header className="ws__bar">
        <div className="ws__brand mono">
          <span>MOD-16</span>
          <strong>MOSAIC</strong>
        </div>

        <nav className="ws__tabs">
          {boards.map((board) => (
            <button
              key={board.id}
              className={`ws__tab mono${board.id === activeId ? ' is-active' : ''}`}
              onClick={() => {
                setActiveId(board.id);
                void api.setActiveBoard(board.id).catch(() => undefined);
              }}
              onDoubleClick={() => {
                const name = window.prompt('Rename this board', board.name)?.trim();
                if (name) void api.renameBoard(board.id, name).then(loadBoards).catch((e) => guard(e, 'Rename failed'));
              }}
              title="Double-click to rename"
            >
              {board.name.toUpperCase()}
            </button>
          ))}
          <button
            className="ws__tab mono"
            title="New board"
            onClick={() => {
              const name = window.prompt('Name the new board')?.trim();
              if (name) void api.createBoard(name).then(loadBoards).catch((e) => guard(e, 'Could not create the board'));
            }}
          >
            +
          </button>
        </nav>

        <span className="ws__spacer" />

        <button className="ws__tab mono" onClick={() => setPicking(true)}>
          ADD PANE
        </button>
        {boards.length > 1 && active && (
          <button
            className="ws__tab mono"
            title="Delete this board"
            onClick={() => {
              if (!window.confirm(`Delete the board "${active.name}"?`)) return;
              void api.deleteBoard(active.id).then(loadBoards).catch((e) => guard(e, 'Could not delete the board'));
            }}
          >
            ✕ BOARD
          </button>
        )}
        <button
          className="ws__tab mono"
          onClick={() => void api.logout().then(() => setLoggedOut(true)).catch(() => setLoggedOut(true))}
        >
          SIGN OUT · {me}
        </button>
      </header>

      {catalogue && !catalogue.identity_configured && (
        /*
         * Without PS-01 every operator authenticates as the same account, so
         * they share one set of boards — and every pane hands that one identity
         * to the module it frames. Stated rather than left to be discovered.
         */
        <div className="ws__notice mono">
          <strong>NO IDENTITY PROVIDER.</strong> Everyone signs in as <code>{me}</code>, so boards are shared and every
          module a pane opens is opened as that one account. Set <code>IDENTITY_URL</code> and <code>IDENTITY_ORG</code>{' '}
          to give people separate boards and their own names.
        </div>
      )}

      {active && active.panes.length === 0 && (
        <p className="ws__empty mono">
          THIS BOARD IS EMPTY — <button className="ws__link mono" onClick={() => setPicking(true)}>ADD A PANE</button> TO
          PUT A MODULE ON IT
        </p>
      )}

      {active && (
        <Board
          panes={active.panes}
          onLayout={(placements) => void saveLayout(placements)}
          onRemove={(id) => void removePane(id)}
          title={(pane) => {
            const peer = moduleOf(pane.module_id);
            return { source: peer?.n ?? 'MOD-??', label: peer?.label ?? pane.module_id };
          }}
        >
          {(pane) => <PaneFrame module={moduleOf(pane.module_id)} />}
        </Board>
      )}

      {picking && catalogue && (
        <PanePicker
          modules={catalogue.modules}
          onAdd={(moduleId) => void addPane(moduleId)}
          onClose={() => setPicking(false)}
        />
      )}

      {toast && <div className={`toast mono${toast.bad ? ' toast--bad' : ''}`}>{toast.text}</div>}
    </div>
  );
}
