import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { GRID_COLUMNS, MAX_PANE_H, MAX_PANE_W, MIN_PANE_H, MIN_PANE_W, type Pane, type PanePlacement } from '../../shared/types';

/**
 * The board grid: plain CSS grid, moved and resized with pointer events.
 *
 * No drag-and-drop library, in keeping with the catalogue's dependency stance
 * (MOD-02 ships ~500 lines of hand-rolled CSS and no framework). The whole
 * interaction is: capture the pointer on a header or a grip, convert the
 * pointer's offset into whole grid cells, and preview the result until release.
 *
 * Two things this deliberately does NOT do. It does not reflow other panes
 * out of the way — overlap is allowed, because an auto-packing grid moves
 * things the person did not touch and that is far more annoying than an overlap
 * they can see and fix. And it does not persist mid-drag: one PUT on release,
 * so a drag across the board is one row in the log rather than forty.
 */

interface Props {
  panes: Pane[];
  /** Called once, on release, with the whole new arrangement. */
  onLayout: (placements: PanePlacement[]) => void;
  onRemove: (paneId: number) => void;
  /** Renders a pane's contents; the frame and chrome are this component's. */
  children: (pane: Pane) => ReactNode;
  /** Header label for a pane — its module and key, resolved by the caller. */
  title: (pane: Pane) => { source: string; label: string };
}

type Gesture =
  | { kind: 'move'; id: number; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'resize'; id: number; startX: number; startY: number; originW: number; originH: number };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function Board({ panes, onLayout, onRemove, children, title }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  /** The in-flight arrangement. Null when nothing is being dragged. */
  const [preview, setPreview] = useState<Map<number, PanePlacement> | null>(null);

  /** One grid cell in pixels, measured live so a resized window stays correct. */
  const cellSize = useCallback((): { w: number; h: number } => {
    const el = gridRef.current;
    if (!el) return { w: 1, h: 1 };
    const style = getComputedStyle(el);
    const gap = parseFloat(style.columnGap || '12') || 12;
    const padding = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
    const usable = el.clientWidth - padding;
    return {
      w: (usable - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS + gap,
      h: (parseFloat(style.gridAutoRows || '72') || 72) + gap,
    };
  }, []);

  const placementOf = useCallback(
    (pane: Pane): PanePlacement =>
      preview?.get(pane.id) ?? { id: pane.id, x: pane.x, y: pane.y, w: pane.w, h: pane.h },
    [preview],
  );

  const begin = (event: ReactPointerEvent, next: Gesture): void => {
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setGesture(next);
    setPreview(new Map(panes.map((w) => [w.id, { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }])));
  };

  const onPointerMove = (event: ReactPointerEvent): void => {
    if (!gesture || !preview) return;
    const cell = cellSize();
    const dx = Math.round((event.clientX - gesture.startX) / cell.w);
    const dy = Math.round((event.clientY - gesture.startY) / cell.h);

    const next = new Map(preview);
    const current = next.get(gesture.id);
    if (!current) return;

    if (gesture.kind === 'move') {
      const w = current.w;
      next.set(gesture.id, {
        ...current,
        x: clamp(gesture.originX + dx, 0, GRID_COLUMNS - w),
        y: Math.max(0, gesture.originY + dy),
      });
    } else {
      const w = clamp(gesture.originW + dx, MIN_PANE_W, Math.min(MAX_PANE_W, GRID_COLUMNS - current.x));
      next.set(gesture.id, { ...current, w, h: clamp(gesture.originH + dy, MIN_PANE_H, MAX_PANE_H) });
    }
    setPreview(next);
  };

  const end = (): void => {
    if (!gesture || !preview) return;
    const placements = [...preview.values()];
    const changed = placements.some((p) => {
      const original = panes.find((w) => w.id === p.id);
      return original && (original.x !== p.x || original.y !== p.y || original.w !== p.w || original.h !== p.h);
    });
    setGesture(null);
    setPreview(null);
    // A click on a header is a drag of zero cells. Saving it would write a row
    // and re-render the board for no change at all.
    if (changed) onLayout(placements);
  };

  if (panes.length === 0) {
    return (
      <div className="board board--empty">
        <div>
          <p className="mono">THIS BOARD IS EMPTY</p>
          <p style={{ marginTop: 8, fontSize: 12 }}>Use ADD WIDGET to put something on it.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="board"
      ref={gridRef}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {panes.map((pane) => {
        const place = placementOf(pane);
        const head = title(pane);
        return (
          <section
            key={pane.id}
            className={`pane${gesture?.id === pane.id ? ' is-dragging' : ''}`}
            style={{
              gridColumn: `${place.x + 1} / span ${place.w}`,
              gridRow: `${place.y + 1} / span ${place.h}`,
            }}
          >
            <header
              className="pane__head mono"
              onPointerDown={(e) =>
                begin(e, { kind: 'move', id: pane.id, startX: e.clientX, startY: e.clientY, originX: place.x, originY: place.y })
              }
            >
              <span className="pane__src">{head.source}</span>
              <span>{head.label}</span>
              <span style={{ flex: 1 }} />
              <button
                className="pane__x"
                title="Remove from this board"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(pane.id)}
              >
                ✕
              </button>
            </header>
            <div className="pane__body">{children(pane)}</div>
            <div
              className="pane__grip"
              title="Resize"
              onPointerDown={(e) =>
                begin(e, { kind: 'resize', id: pane.id, startX: e.clientX, startY: e.clientY, originW: place.w, originH: place.h })
              }
            />
          </section>
        );
      })}
    </div>
  );
}
