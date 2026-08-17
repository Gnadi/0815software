import { useState } from 'react';
import type { ActivityEvent, PeerSummary, Widget } from '../../shared/types';
import type { SummaryList, SummaryTile } from '../../shared/summary';
import type { CatalogueAction, CatalogueModule } from '../api';

/**
 * What goes inside a widget's frame.
 *
 * Every branch here has an explicit unavailable state, and that is the point.
 * A dashboard's characteristic failure is showing a stale or empty number as if
 * it were current — so a widget whose module is down, unwired, or no longer
 * offering its key says exactly that, rather than rendering a confident zero.
 */

interface Props {
  widget: Widget;
  summaries: Map<string, PeerSummary>;
  modules: Map<string, CatalogueModule>;
  actions: CatalogueAction[];
  activity: ActivityEvent[];
  activityConfigured: boolean;
  onOpen: (moduleId: string, path: string) => void;
  onAction: (actionId: string, itemId: string) => Promise<void>;
}

function Unavailable({ reason }: { reason: string }) {
  return <p className="widget__problem">{reason}</p>;
}

function Tile({ tile, onOpen }: { tile: SummaryTile; onOpen: () => void }) {
  return (
    <div className="tile">
      <span className={`tile__value tile__value--${tile.tone}`}>{tile.value}</span>
      {tile.unit && <span className="tile__unit mono">{tile.unit.toUpperCase()}</span>}
      {tile.href && (
        <button className="row__act mono" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={onOpen}>
          OPEN →
        </button>
      )}
    </div>
  );
}

function List({
  list,
  actions,
  onOpen,
  onAction,
}: {
  list: SummaryList;
  actions: CatalogueAction[];
  onOpen: (path: string) => void;
  onAction: (actionId: string, itemId: string) => Promise<void>;
}) {
  const [running, setRunning] = useState<string | null>(null);

  if (list.items.length === 0) return <p className="widget__stale mono">NOTHING HERE</p>;

  return (
    <div className="rows">
      {list.items.map((item) => (
        <div className="row" key={item.id}>
          <div className="row__main">
            {item.href ? (
              <button className="row__title" onClick={() => onOpen(item.href!)}>
                {item.title}
              </button>
            ) : (
              <span className="row__title">{item.title}</span>
            )}
            <span className="row__sub mono">
              {[item.subtitle, item.badge, item.at?.slice(0, 10)].filter(Boolean).join(' · ')}
            </span>
          </div>
          {actions.map((action) => (
            <button
              key={action.id}
              className="row__act mono"
              disabled={running !== null}
              onClick={() => {
                setRunning(`${action.id}:${item.id}`);
                void onAction(action.id, item.id).finally(() => setRunning(null));
              }}
            >
              {running === `${action.id}:${item.id}` ? '…' : action.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function WidgetBody({
  widget,
  summaries,
  modules,
  actions,
  activity,
  activityConfigured,
  onOpen,
  onAction,
}: Props) {
  if (widget.kind === 'activity') {
    if (!activityConfigured && activity.length === 0) {
      return <Unavailable reason="PS-07 Audit Log is not configured for this stack, so there is no activity to show." />;
    }
    if (activity.length === 0) return <p className="widget__stale mono">NOTHING RECORDED YET</p>;
    return (
      <div className="rows">
        {activity.map((event) => (
          <div className="row" key={event.id}>
            <div className="row__main">
              <span className="row__title">{event.action}</span>
              <span className="row__sub mono">
                {[event.actor, modules.get(event.module ?? '')?.label ?? event.module, event.at.slice(0, 16).replace('T', ' ')]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (widget.kind === 'launcher') {
    const installed = [...modules.values()].filter((m) => m.configured);
    if (installed.length === 0) {
      return <Unavailable reason="No modules are wired to this Workspace yet — set <MODULE>_URL to put them on the board." />;
    }
    return (
      <div className="launcher">
        {installed.map((module) => (
          <button
            key={module.id}
            className="launcher__item"
            disabled={!module.embeddable && module.publicUrl === null}
            title={module.embeddable ? 'Open inside the Workspace' : 'Open in a new tab'}
            onClick={() => onOpen(module.id, '/')}
          >
            <span className="launcher__n mono">{module.n}</span>
            <span className="launcher__label">{module.label}</span>
          </button>
        ))}
      </div>
    );
  }

  // Everything below is fed by a peer.
  const moduleId = widget.module_id!;
  const module = modules.get(moduleId);
  if (!module?.configured) {
    return <Unavailable reason={`${module?.label ?? moduleId} is not in this stack.`} />;
  }

  const peer = summaries.get(moduleId);
  if (!peer) return <p className="widget__stale mono">LOADING…</p>;
  if (!peer.ok) return <Unavailable reason={`${module.label} ${peer.problem}.`} />;

  if (widget.kind === 'embed') {
    return (
      <div className="tile">
        <button className="btn" onClick={() => onOpen(moduleId, '/')}>
          OPEN {module.label.toUpperCase()} →
        </button>
      </div>
    );
  }

  if (widget.kind === 'tile') {
    const tile = peer.summary.tiles.find((t) => t.key === widget.widget_key);
    if (!tile) {
      // The module is healthy but no longer offers this key — an upgrade
      // retired it. Saying so beats a blank card, and keeping the widget beats
      // deleting a layout on the module's behalf.
      return <Unavailable reason={`${module.label} no longer offers “${widget.widget_key}”.`} />;
    }
    return <Tile tile={tile} onOpen={() => onOpen(moduleId, tile.href ?? '/')} />;
  }

  const list = peer.summary.lists.find((l) => l.key === widget.widget_key);
  if (!list) return <Unavailable reason={`${module.label} no longer offers “${widget.widget_key}”.`} />;
  return (
    <List
      list={list}
      actions={actions.filter(
        (a) => a.available && a.source_module === moduleId && a.source_list === list.key,
      )}
      onOpen={(path) => onOpen(moduleId, path)}
      onAction={onAction}
    />
  );
}
