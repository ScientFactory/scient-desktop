import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { FlaskConical, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  SCIENT_UX_LAB_ENABLED,
  readUxLabControlPosition,
  readSourcesLabScenario,
  saveUxLabControlPosition,
  selectSourcesLabScenario,
  sourcesLabScenarios,
  type SourcesLabScenario,
  type UxLabControlPosition,
} from "./state";

const VIEWPORT_MARGIN = 8;

function clampPosition(
  position: UxLabControlPosition,
  size: { readonly width: number; readonly height: number },
): UxLabControlPosition {
  return {
    x: Math.min(
      Math.max(position.x, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - size.width - VIEWPORT_MARGIN),
    ),
    y: Math.min(
      Math.max(position.y, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - size.height - VIEWPORT_MARGIN),
    ),
  };
}

export function ScientUxLabHost() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<UxLabControlPosition | null>(readUxLabControlPosition);
  const latestPositionRef = useRef(position);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    readonly pointerX: number;
    readonly pointerY: number;
    readonly originX: number;
    readonly originY: number;
    moved: boolean;
  } | null>(null);
  const ignoreClickRef = useRef(false);

  useEffect(() => {
    const keepControlOnScreen = () => {
      const root = rootRef.current;
      if (root === null || position === null) return;
      const next = clampPosition(position, root.getBoundingClientRect());
      latestPositionRef.current = next;
      setPosition(next);
      saveUxLabControlPosition(next);
    };
    window.addEventListener("resize", keepControlOnScreen);
    return () => window.removeEventListener("resize", keepControlOnScreen);
  }, [position]);

  useEffect(() => {
    const continueDragging = (event: MouseEvent) => {
      const drag = dragRef.current;
      const root = rootRef.current;
      if (drag === null || root === null) return;
      const deltaX = event.clientX - drag.pointerX;
      const deltaY = event.clientY - drag.pointerY;
      if (Math.hypot(deltaX, deltaY) >= 3) drag.moved = true;
      if (!drag.moved) return;
      const next = clampPosition(
        { x: drag.originX + deltaX, y: drag.originY + deltaY },
        root.getBoundingClientRect(),
      );
      latestPositionRef.current = next;
      setPosition(next);
    };

    const finishDragging = () => {
      const drag = dragRef.current;
      if (drag === null) return;
      ignoreClickRef.current = drag.moved;
      if (drag.moved && latestPositionRef.current !== null) {
        saveUxLabControlPosition(latestPositionRef.current);
      }
      dragRef.current = null;
    };

    window.addEventListener("mousemove", continueDragging);
    window.addEventListener("mouseup", finishDragging);
    return () => {
      window.removeEventListener("mousemove", continueDragging);
      window.removeEventListener("mouseup", finishDragging);
    };
  }, []);

  if (!SCIENT_UX_LAB_ENABLED) return null;

  const activeScenario = readSourcesLabScenario();

  const startDragging = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || rootRef.current === null) return;
    const bounds = rootRef.current.getBoundingClientRect();
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: bounds.left,
      originY: bounds.top,
      moved: false,
    };
    event.preventDefault();
  };

  return (
    <div
      className="pointer-events-none fixed z-[100] flex w-72 flex-col items-start gap-2"
      ref={rootRef}
      style={position === null ? { left: 16, bottom: 16 } : { left: position.x, top: position.y }}
    >
      {open ? (
        <section className="pointer-events-auto w-72 rounded-xl border border-border bg-background/95 p-3 text-foreground shadow-xl backdrop-blur">
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FlaskConical className="size-4" aria-hidden="true" />
                Scient UX Lab
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Real app · synthetic external state
              </p>
            </div>
            <Button
              aria-label="Close UX Lab controls"
              className="size-7"
              onClick={() => setOpen(false)}
              size="icon"
              variant="ghost"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </header>

          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor="ux-lab-journey"
          >
            Journey
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            disabled
            id="ux-lab-journey"
            value="zotero-sources"
          >
            <option value="zotero-sources">Zotero sources</option>
          </select>

          <label
            className="mt-3 block text-xs font-medium text-muted-foreground"
            htmlFor="ux-lab-scenario"
          >
            Scenario
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            id="ux-lab-scenario"
            onChange={(event) =>
              selectSourcesLabScenario(event.currentTarget.value as SourcesLabScenario)
            }
            value={activeScenario}
          >
            {sourcesLabScenarios.map((scenario) => (
              <option key={scenario.value} value={scenario.value}>
                {scenario.label}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      <Button
        className="pointer-events-auto cursor-grab touch-none gap-2 shadow-lg active:cursor-grabbing"
        onClick={() => {
          if (ignoreClickRef.current) {
            ignoreClickRef.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
        onMouseDown={startDragging}
        size="sm"
        title="Drag to move · Click to open"
      >
        <FlaskConical className="size-4" aria-hidden="true" />
        UX Lab
      </Button>
    </div>
  );
}
