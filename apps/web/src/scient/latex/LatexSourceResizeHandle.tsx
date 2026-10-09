import { useRef, useState, type RefObject } from "react";

const minimumHeight = 64;

/** The bottom stays anchored to the footer; lifting this edge enlarges the code field. */
export function LatexSourceResizeHandle({
  field,
  onResize,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  onResize: (height: number) => void;
}) {
  const [size, setSize] = useState({ height: minimumHeight, maximum: 320 });
  const drag = useRef<{ id: number; y: number; height: number; maximum: number } | null>(null);
  const measure = () => {
    const bounds = field.current?.getBoundingClientRect();
    if (!bounds) return null;
    const viewport = window.visualViewport;
    return {
      height: bounds.height,
      maximum: Math.max(
        minimumHeight,
        Math.min(
          320,
          (viewport?.height ?? window.innerHeight) * 0.6,
          bounds.bottom - (viewport?.offsetTop ?? 0) - 24,
        ),
      ),
    };
  };
  const resize = (height: number, maximum: number) => {
    if (!field.current) return;
    const next = Math.round(Math.max(minimumHeight, Math.min(maximum, height)));
    onResize(next);
    setSize({ height: next, maximum });
  };
  return (
    <div
      className="scient-latex-source-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize LaTeX code editor"
      aria-orientation="horizontal"
      aria-valuemin={minimumHeight}
      aria-valuemax={Math.round(size.maximum)}
      aria-valuenow={Math.round(size.height)}
      aria-valuetext={`${Math.round(size.height)} pixels high`}
      onFocus={() => {
        const measured = measure();
        if (measured) setSize(measured);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        const measured = measure();
        if (!measured) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, y: event.clientY, ...measured };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        event.preventDefault();
        resize(active.height + active.y - event.clientY, active.maximum);
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        resize(active.height + active.y - event.clientY, active.maximum);
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (drag.current?.id === event.pointerId) drag.current = null;
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.id === event.pointerId) drag.current = null;
      }}
      onKeyDown={(event) => {
        const measured = measure();
        if (!measured) return;
        const height =
          event.key === "ArrowUp"
            ? measured.height + 20
            : event.key === "ArrowDown"
              ? measured.height - 20
              : event.key === "Home"
                ? minimumHeight
                : event.key === "End"
                  ? measured.maximum
                  : null;
        if (height === null) return;
        event.preventDefault();
        event.stopPropagation();
        resize(height, measured.maximum);
      }}
    />
  );
}
