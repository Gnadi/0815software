import type { PeerSummary } from '../../shared/types';
import type { CatalogueModule } from '../api';

/**
 * What can go on a board.
 *
 * The list is built from what the peers ACTUALLY offered on the last refresh,
 * not from a hardcoded catalogue of widget names. A module that adds a tile in
 * a new version appears here without the Workspace being changed, and one that
 * is down offers nothing rather than offering widgets that would not render.
 */

interface Props {
  modules: CatalogueModule[];
  summaries: PeerSummary[];
  onAdd: (widget: Record<string, unknown>) => void;
  onClose: () => void;
}

export function WidgetPicker({ modules, summaries, onAdd, onClose }: Props) {
  const labelOf = (id: string): string => modules.find((m) => m.id === id)?.label ?? id;

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker__card" onClick={(e) => e.stopPropagation()}>
        <div className="picker__group">
          <h3 className="mono">THE WORKSPACE ITSELF</h3>
          <div className="picker__opts">
            <button className="picker__opt" onClick={() => onAdd({ kind: 'launcher', w: 12, h: 2 })}>
              Module launcher
            </button>
            <button className="picker__opt" onClick={() => onAdd({ kind: 'activity', w: 6, h: 4 })}>
              Activity feed
            </button>
          </div>
        </div>

        {summaries.map((peer) => (
          <div className="picker__group" key={peer.module}>
            <h3 className="mono">{labelOf(peer.module).toUpperCase()}</h3>
            {!peer.ok ? (
              <p className="widget__problem">{peer.problem}</p>
            ) : (
              <div className="picker__opts">
                {peer.summary.tiles.map((tile) => (
                  <button
                    key={tile.key}
                    className="picker__opt"
                    onClick={() => onAdd({ kind: 'tile', module_id: peer.module, widget_key: tile.key, w: 3, h: 2 })}
                  >
                    {tile.label}
                  </button>
                ))}
                {peer.summary.lists.map((list) => (
                  <button
                    key={list.key}
                    className="picker__opt"
                    onClick={() => onAdd({ kind: 'list', module_id: peer.module, widget_key: list.key, w: 6, h: 4 })}
                  >
                    {list.label}
                  </button>
                ))}
                {modules.find((m) => m.id === peer.module)?.embeddable && (
                  <button
                    className="picker__opt"
                    onClick={() => onAdd({ kind: 'embed', module_id: peer.module, w: 4, h: 2 })}
                  >
                    Open {labelOf(peer.module)} …
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {summaries.length === 0 && (
          <p className="widget__stale mono">NO MODULES ARE WIRED TO THIS WORKSPACE YET</p>
        )}

        <button className="btn" onClick={onClose} style={{ marginTop: 8 }}>
          DONE
        </button>
      </div>
    </div>
  );
}
