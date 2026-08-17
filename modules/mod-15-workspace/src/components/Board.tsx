import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { GRID_COLUMNS, MAX_WIDGET_H, MAX_WIDGET_W, MIN_WIDGET_H, MIN_WIDGET_W, type Widget, type WidgetPlacement } from '../../shared/types';

/**
 * The board grid: plain CSS grid, moved and resized with pointer events.
 *
 * No drag-and-drop library, in keeping with the catalogue's dependency stance
 * (MOD-02 ships ~500 lines of hand-rolled CSS and no framework). The whole
 * interaction is: capture the pointer on a header or a grip, convert the
 * pointer's offset into whole grid cells, and preview the result until release.
 *
 * Two things this deliberately does NOT do. It does not reflow other widgets
 * out of the way — overlap is allowed, because an auto-packing grid moves
 * things the person did not touch and that is far more annoying than an overlap
 * they can see and fix. And it does not persist mid-drag: one PUT on release,
 * so a drag across the board is one row in the log rather than forty.
 */

interface Props {
  widgets: Widget[];
  /** Called once, on release, with the whole new arrangement. */
  onLayout: (placements: WidgetPlacement[]) => void;
  onRemove: (widgetId: number) => void;
  /** Renders a widget's contents; the frame and chrome are this component's. */
  children: (widget: Widget) => ReactNode;
  /** Header label for a widget — its module and key, resolved by the caller. */
  title: (widget: Widget) => { source: string; label: string };
}

type Gesture =
  | { kind: 'move'; id: number; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'resize'; id: number; startX: number; startY: number; originW: number; originH: number };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function Board({ widgets, onLayout, onRemove, children, title }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  /** The in-flight arrangement. Null when nothing is being dragged. */
  const [preview, setPreview] = useState<Map<number, WidgetPlacement> | null>(null);

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
    (widget: Widget): WidgetPlacement =>
      preview?.get(widget.id) ?? { id: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h },
    [preview],
  );

  const begin = (event: ReactPointerEvent, next: Gesture): void => {
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setGesture(next);
    setPreview(new Map(widgets.map((w) => [w.id, { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }])));
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
      const w = clamp(gesture.originW + dx, MIN_WIDGET_W, Math.min(MAX_WIDGET_W, GRID_COLUMNS - current.x));
      next.set(gesture.id, { ...current, w, h: clamp(gesture.originH + dy, MIN_WIDGET_H, MAX_WIDGET_H) });
    }
    setPreview(next);
  };

  const end = (): void => {
    if (!gesture || !preview) return;
    const placements = [...preview.values()];
    const changed = placements.some((p) => {
      const original = widgets.find((w) => w.id === p.id);
      return original && (original.x !== p.x || original.y !== p.y || original.w !== p.w || original.h !== p.h);
    });
    setGesture(null);
    setPreview(null);
    // A click on a header is a drag of zero cells. Saving it would write a row
    // and re-render the board for no change at all.
    if (changed) onLayout(placements);
  };

  if (widgets.length === 0) {
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
      {widgets.map((widget) => {
        const place = placementOf(widget);
        const head = title(widget);
        return (
          <section
            key={widget.id}
            className={`widget${gesture?.id === widget.id ? ' is-dragging' : ''}`}
            style={{
              gridColumn: `${place.x + 1} / span ${place.w}`,
              gridRow: `${place.y + 1} / span ${place.h}`,
            }}
          >
            <header
              className="widget__head mono"
              onPointerDown={(e) =>
                begin(e, { kind: 'move', id: widget.id, startX: e.clientX, startY: e.clientY, originX: place.x, originY: place.y })
              }
            >
              <span className="widget__src">{head.source}</span>
              <span>{head.label}</span>
              <span style={{ flex: 1 }} />
              <button
                className="widget__x"
                title="Remove from this board"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(widget.id)}
              >
                ✕
              </button>
            </header>
            <div className="widget__body">{children(widget)}</div>
            <div
              className="widget__grip"
              title="Resize"
              onPointerDown={(e) =>
                begin(e, { kind: 'resize', id: widget.id, startX: e.clientX, startY: e.clientY, originW: place.w, originH: place.h })
              }
            />
          </section>
        );
      })}
    </div>
  );
}
