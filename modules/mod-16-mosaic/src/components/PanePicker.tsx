import type { PeerStatus } from '../../shared/types';

/**
 * Which modules can be tiled.
 *
 * Three states, kept apart on purpose, because they have three different
 * fixes and a picker that lumps them together sends people looking in the
 * wrong place:
 *
 *   - TILEABLE — in the stack, framable, and a browser-reachable origin known.
 *   - WIRED BUT NOT FRAMABLE — either no public URL was set, or the module
 *     authenticates its own end users (MOD-01 Portal, MOD-07 Storefront,
 *     MOD-09 Documents) and a staff shell has no identity to assert in it.
 *   - NOT IN THIS STACK — not licensed, or simply not configured here.
 *
 * The last group is shown greyed rather than hidden: "the module I want is
 * missing" is a question the picker should answer, not one it should leave
 * someone guessing at.
 */

interface Props {
  modules: PeerStatus[];
  onAdd: (moduleId: string) => void;
  onClose: () => void;
}

export function PanePicker({ modules, onAdd, onClose }: Props) {
  const tileable = modules.filter((m) => m.embeddable);
  const blocked = modules.filter((m) => m.configured && !m.embeddable);
  const absent = modules.filter((m) => !m.configured);

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker__card" onClick={(e) => e.stopPropagation()}>
        <div className="picker__group">
          <h3 className="mono">ADD A MODULE</h3>
          {tileable.length === 0 ? (
            <p className="picker__empty mono">
              NOTHING CAN BE TILED YET — EACH MODULE NEEDS ITS URL, ITS PUBLIC URL, AND THIS ORIGIN IN ITS SHELL_ORIGIN
            </p>
          ) : (
            <div className="picker__opts">
              {tileable.map((m) => (
                <button className="picker__opt" key={m.id} onClick={() => onAdd(m.id)}>
                  <span className="picker__n mono">{m.n}</span>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {blocked.length > 0 && (
          <div className="picker__group">
            <h3 className="mono">IN THIS STACK, BUT NOT FRAMABLE</h3>
            <div className="picker__opts">
              {blocked.map((m) => (
                <span className="picker__opt is-off" key={m.id}>
                  <span className="picker__n mono">{m.n}</span>
                  {m.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {absent.length > 0 && (
          <div className="picker__group">
            <h3 className="mono">NOT IN THIS STACK</h3>
            <div className="picker__opts">
              {absent.map((m) => (
                <span className="picker__opt is-off" key={m.id}>
                  <span className="picker__n mono">{m.n}</span>
                  {m.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <button className="btn mono picker__close" onClick={onClose}>
          CLOSE
        </button>
      </div>
    </div>
  );
}
