import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Catalogue } from './api';
import { Login } from './components/Login';
import { Board } from './components/Board';
import { PaneFrame } from './components/PaneFrame';
import { PanePicker } from './components/PanePicker';
import type { Board as BoardModel, PanePlacement } from '../shared/types';
import { forgetOffline, isOffline, keepOffline, readOffline, signOutOfModules } from './frame';

/** What the installed app keeps to open without a connection (src/frame.ts) — the arrangement, no data. */
const OFFLINE_KEY = 'mosaic.offline';
interface KeptOffline {
  me: string;
  catalogue: Catalogue;
  boards: BoardModel[];
  active: number | null;
}

/** A phone: one module at a time, full screen, and a bar to switch. */
const NARROW = '(max-width: 700px)';
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}

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
  /** Started without a connection: the arrangement from this device, panes that can open offline. */
  const [offline, setOffline] = useState(false);
  const narrow = useNarrow();
  /** On a phone, the pane on screen. */
  const [shown, setShown] = useState<number | null>(null);

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
    // The arrangement this device opens with when there is no connection.
    const kept = readOffline<KeptOffline>(OFFLINE_KEY);
    if (kept) keepOffline<KeptOffline>(OFFLINE_KEY, { ...kept, boards: rows, active: preferences.active_board });
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
      const cat = await api.catalogue();
      keepOffline<KeptOffline>(OFFLINE_KEY, { me: username, catalogue: cat, boards: [], active: null });
      await loadBoards();
      setCatalogue(cat);
      setOffline(false);
      setReady(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setLoggedOut(true);
        return;
      }
      const kept = readOffline<KeptOffline>(OFFLINE_KEY);
      if (isOffline(err) && kept) {
        setMe(kept.me);
        setCatalogue(kept.catalogue);
        setBoards(kept.boards);
        setActiveId(kept.active ?? kept.boards[0]?.id ?? null);
        setOffline(true);
        setReady(true);
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

  // Back online: start again, and every pane gets its ticket.
  useEffect(() => {
    if (!offline) return;
    const up = () => void boot();
    window.addEventListener('online', up);
    return () => window.removeEventListener('online', up);
  }, [offline, boot]);

  const signOut = useCallback(() => {
    void signOutOfModules(catalogue?.modules ?? [])
      .then(() => api.logout())
      .catch(() => undefined)
      .then(() => {
        forgetOffline(OFFLINE_KEY);
        setReady(false);
        setLoggedOut(true);
      });
  }, [catalogue]);

  /** Changes to the arrangement need the server; offline, they are refused with a word. */
  const online = useCallback(
    (work: () => void) => {
      if (offline) say('Offline — the arrangement can be changed when the connection is back', true);
      else work();
    },
    [offline, say],
  );

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

        {offline && <span className="ws__offline mono">OFFLINE</span>}
        <button className="ws__tab mono" onClick={() => online(() => setPicking(true))}>
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
        <button className="ws__tab mono" onClick={signOut} title="Signs you out of every module opened here, too">
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

      {active && narrow && active.panes.length > 0 && (
        <div className="phone">
          {/* Every pane stays mounted, so switching keeps each module where it was. */}
          {active.panes.map((pane) => (
            <div key={pane.id} className={`phone__pane${(shown ?? active.panes[0]!.id) === pane.id ? ' is-shown' : ''}`}>
              <PaneFrame module={moduleOf(pane.module_id)} offline={offline} />
            </div>
          ))}
          <nav className="phone__tabs">
            {active.panes.map((pane) => (
              <button
                key={pane.id}
                className={`phone__tab mono${(shown ?? active.panes[0]!.id) === pane.id ? ' is-active' : ''}`}
                onClick={() => setShown(pane.id)}
              >
                {(moduleOf(pane.module_id)?.label ?? pane.module_id).toUpperCase()}
              </button>
            ))}
          </nav>
        </div>
      )}

      {active && !narrow && (
        <Board
          panes={active.panes}
          onLayout={(placements) => online(() => void saveLayout(placements))}
          onRemove={(id) => online(() => void removePane(id))}
          title={(pane) => {
            const peer = moduleOf(pane.module_id);
            return { source: peer?.n ?? 'MOD-??', label: peer?.label ?? pane.module_id };
          }}
        >
          {(pane) => <PaneFrame module={moduleOf(pane.module_id)} offline={offline} />}
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
