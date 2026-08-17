import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Catalogue } from './api';
import { Board } from './components/Board';
import { ContextBar } from './components/ContextBar';
import { Login } from './components/Login';
import { WidgetBody } from './components/WidgetBody';
import { WidgetPicker } from './components/WidgetPicker';
import type { ActivityEvent, Board as BoardModel, PeerSummary, ShellContext, Widget, WidgetPlacement } from '../shared/types';

/**
 * The Workspace shell.
 *
 * One screen: a bar with the boards and the shared context, a grid of widgets,
 * and a full-screen frame when a module is opened inside it. Navigation is
 * component state — no router, same as every other module in the catalogue.
 *
 * The refresh rule is the one worth stating: changing the context re-fetches
 * every summary, because the context is the question every widget is answering.
 * Nothing is cached between refreshes; a figure on this board is always one the
 * owning module produced just now.
 */

/**
 * How often an open board re-asks every module.
 *
 * Sixty seconds is chosen against the modules, not the reader: these are
 * SQLite-backed services and a board fans out to all of them at once. Faster
 * would buy very little — these figures change on the scale of a working day —
 * and would cost every module in the stack.
 */
const REFRESH_MS = 60_000;

interface Embed {
  moduleId: string;
  label: string;
  url: string;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);

  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [boards, setBoards] = useState<BoardModel[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [context, setContext] = useState<ShellContext>({});
  const [summaries, setSummaries] = useState<PeerSummary[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activityConfigured, setActivityConfigured] = useState(false);

  const [picking, setPicking] = useState(false);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    setTimeout(() => setToast(null), bad ? 6000 : 3500);
  }, []);

  const onAuthLost = useCallback(() => {
    setReady(false);
    setLoggedOut(true);
  }, []);

  /** Anything that fails with a 401 means the session went; everything else is a toast. */
  const guard = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else say(err instanceof Error ? err.message : fallback, true);
    },
    [onAuthLost, say],
  );

  const loadBoards = useCallback(async () => {
    const { boards: loaded, preferences } = await api.boards();
    setBoards(loaded);
    setContext(preferences.context);
    setActiveId((current) => {
      if (current !== null && loaded.some((b) => b.id === current)) return current;
      const preferred = loaded.find((b) => b.id === preferences.active_board);
      return (preferred ?? loaded[0])?.id ?? null;
    });
  }, []);

  const loadWidgetData = useCallback(async () => {
    // Both fail soft: the board renders with whatever arrived, and each widget
    // says for itself why it has nothing. A dashboard that refuses to draw
    // because one call failed is the failure mode this avoids.
    const [peerResult, activityResult] = await Promise.allSettled([api.summaries(), api.activity()]);
    if (peerResult.status === 'fulfilled') setSummaries(peerResult.value.summaries);
    if (activityResult.status === 'fulfilled') {
      setActivity(activityResult.value.events);
      // Whether PS-07 is wired is the SERVER's answer. Deriving it on the
      // client from "are there any modules" made it always true, so an unwired
      // audit log rendered as an empty feed rather than an unconfigured one.
      setActivityConfigured(activityResult.value.configured);
    }
  }, []);

  const boot = useCallback(async () => {
    try {
      await api.me();
      setLoggedOut(false);
      const [cat] = await Promise.all([api.catalogue(), loadBoards()]);
      setCatalogue(cat);
      setReady(true);
      void loadWidgetData();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLoggedOut(true);
      else throw err;
    }
  }, [loadBoards, loadWidgetData]);

  useEffect(() => {
    void boot();
  }, [boot]);

  /**
   * Keep the board current on its own.
   *
   * A dashboard is left open. Without this it would sit showing this morning's
   * figures looking perfectly current, which is the characteristic way a
   * dashboard lies.
   *
   * Only while the tab is VISIBLE, and once immediately on becoming visible
   * again. A board on a background tab is being read by nobody, and every tick
   * of it is a round of requests to every module in the stack — so the pause is
   * as much for the modules as for this page. The server collapses simultaneous
   * refreshes into one fan-out per module (`server/peers.ts`).
   */
  useEffect(() => {
    if (!ready) return;

    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible') void loadWidgetData();
    };
    const timer = setInterval(refreshIfVisible, REFRESH_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [ready, loadWidgetData]);

  const active = useMemo(() => boards.find((b) => b.id === activeId) ?? null, [boards, activeId]);

  const moduleMap = useMemo(
    () => new Map((catalogue?.modules ?? []).map((m) => [m.id, m])),
    [catalogue],
  );
  const summaryMap = useMemo(() => new Map(summaries.map((s) => [s.module, s])), [summaries]);

  // ── Actions on the board ────────────────────────────────────────────
  const changeContext = useCallback(
    async (next: ShellContext) => {
      setContext(next);
      try {
        await api.setContext(next);
        // The context is the question; re-ask it of every module.
        await loadWidgetData();
      } catch (err) {
        guard(err, 'Could not save the context');
      }
    },
    [guard, loadWidgetData],
  );

  const saveLayout = useCallback(
    async (placements: WidgetPlacement[]) => {
      if (!active) return;
      // Optimistic: the drag already happened on screen, and re-rendering from
      // the server would make a released widget visibly jump back and forth.
      setBoards((current) =>
        current.map((board) =>
          board.id !== active.id
            ? board
            : {
                ...board,
                widgets: board.widgets.map((w) => {
                  const p = placements.find((it) => it.id === w.id);
                  return p ? { ...w, x: p.x, y: p.y, w: p.w, h: p.h } : w;
                }),
              },
        ),
      );
      try {
        await api.saveLayout(active.id, placements);
      } catch (err) {
        guard(err, 'Could not save the layout');
        void loadBoards();
      }
    },
    [active, guard, loadBoards],
  );

  const addWidget = useCallback(
    async (widget: Record<string, unknown>) => {
      if (!active) return;
      try {
        // Drop it below everything already there, so a new widget never lands
        // on top of one someone placed deliberately.
        const y = active.widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
        await api.addWidget(active.id, { ...widget, x: 0, y });
        await loadBoards();
      } catch (err) {
        guard(err, 'Could not add the widget');
      }
    },
    [active, guard, loadBoards],
  );

  const removeWidget = useCallback(
    async (widgetId: number) => {
      if (!active) return;
      try {
        await api.removeWidget(active.id, widgetId);
        await loadBoards();
      } catch (err) {
        guard(err, 'Could not remove the widget');
      }
    },
    [active, guard, loadBoards],
  );

  /**
   * Open a module at a path — inside the Workspace when it can be framed,
   * in a new tab when it cannot.
   *
   * The two cases are not a fallback but a real distinction: MOD-01, MOD-07 and
   * MOD-09 authenticate their own end users, so the Workspace has no identity to
   * hand them and must not pretend otherwise.
   */
  const open = useCallback(
    async (moduleId: string, path: string) => {
      const module = moduleMap.get(moduleId);
      if (!module) return;
      if (!module.embeddable) {
        if (module.publicUrl) window.open(`${module.publicUrl}${path}`, '_blank', 'noopener');
        else say(`${module.label} has no public URL configured`, true);
        return;
      }
      try {
        const { url } = await api.embedUrl(moduleId, path);
        setEmbed({ moduleId, label: module.label, url });
      } catch (err) {
        guard(err, `Could not open ${module.label}`);
      }
    },
    [guard, moduleMap, say],
  );

  const runAction = useCallback(
    async (actionId: string, itemId: string) => {
      try {
        const { message } = await api.runAction(actionId, itemId);
        say(message);
        // Both ends of the action moved: the source lost an item, the target
        // gained one. Re-reading everything is cheaper than reasoning about it.
        await loadWidgetData();
      } catch (err) {
        guard(err, 'The action failed');
      }
    },
    [guard, loadWidgetData, say],
  );

  if (loggedOut) return <Login onSuccess={() => void boot()} />;
  if (!ready) return <div className="boot mono">LOADING…</div>;

  return (
    <div className="ws">
      <header className="ws__bar">
        <div className="ws__brand mono">
          <span>MOD-15</span>
          <strong>WORKSPACE</strong>
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

        <ContextBar
          context={context}
          customersConfigured={catalogue?.customers_configured ?? false}
          onChange={(next) => void changeContext(next)}
        />

        <button className="ws__tab mono" onClick={() => setPicking(true)}>
          ADD WIDGET
        </button>
        <button className="ws__tab mono" onClick={() => void loadWidgetData()} title="Re-read every module">
          REFRESH
        </button>
        {boards.length > 1 && active && (
          <button
            className="ws__tab mono"
            onClick={() => {
              if (window.confirm(`Delete the board “${active.name}”?`)) {
                void api.deleteBoard(active.id).then(loadBoards).catch((e) => guard(e, 'Could not delete the board'));
              }
            }}
          >
            DELETE BOARD
          </button>
        )}
        <button
          className="ws__tab mono"
          onClick={() => {
            void api.logout().then(onAuthLost);
          }}
        >
          LOG OUT ↗
        </button>
      </header>

      {active && (
        <Board
          widgets={active.widgets}
          onLayout={(placements) => void saveLayout(placements)}
          onRemove={(id) => void removeWidget(id)}
          title={(widget: Widget) => ({
            source: widget.module_id ? (moduleMap.get(widget.module_id)?.label ?? widget.module_id) : 'WORKSPACE',
            label: labelFor(widget, summaryMap),
          })}
        >
          {(widget) => (
            <WidgetBody
              widget={widget}
              summaries={summaryMap}
              modules={moduleMap}
              actions={catalogue?.actions ?? []}
              activity={activity}
              activityConfigured={activityConfigured}
              onOpen={(moduleId, path) => void open(moduleId, path)}
              onAction={runAction}
            />
          )}
        </Board>
      )}

      {picking && (
        <WidgetPicker
          modules={catalogue?.modules ?? []}
          summaries={summaries}
          onAdd={(widget) => void addWidget(widget)}
          onClose={() => setPicking(false)}
        />
      )}

      {embed && (
        <div className="embed">
          <div className="embed__bar mono">
            <span>{embed.label.toUpperCase()}</span>
            <span className="ws__spacer" />
            <button
              className="ws__tab mono"
              onClick={() => {
                setEmbed(null);
                // Whatever was done in there almost certainly changed a figure.
                void loadWidgetData();
              }}
            >
              CLOSE ✕
            </button>
          </div>
          <iframe className="embed__frame" src={embed.url} title={embed.label} />
        </div>
      )}

      {toast && <div className={`toast mono${toast.bad ? ' toast--bad' : ''}`}>{toast.text}</div>}
    </div>
  );
}

/**
 * A widget's own label, taken from the module's summary when it is available.
 *
 * The module owns the words. Storing the label at add-time would freeze it, so
 * a module renaming a tile in a new version would leave every board showing the
 * old name — which is the drift the summary contract's stable keys exist to
 * avoid.
 */
function labelFor(widget: Widget, summaries: Map<string, PeerSummary>): string {
  if (widget.kind === 'activity') return 'ACTIVITY';
  if (widget.kind === 'launcher') return 'MODULES';
  if (widget.kind === 'embed') return 'OPEN';
  const peer = widget.module_id ? summaries.get(widget.module_id) : undefined;
  if (!peer?.ok) return (widget.widget_key ?? '').toUpperCase();
  const found =
    peer.summary.tiles.find((t) => t.key === widget.widget_key) ??
    peer.summary.lists.find((l) => l.key === widget.widget_key);
  return (found?.label ?? widget.widget_key ?? '').toUpperCase();
}
