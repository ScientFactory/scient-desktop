import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import {
  SCIENT_UX_LAB_ENABLED,
  matlabLabScenarioDefinition,
  matlabLabScenarios,
  type MatlabLabScenario,
  readMatlabLabScenario,
  readUxLabControlPosition,
  readUxLabJourney,
  readSourcesLabScenario,
  saveUxLabControlPosition,
  selectMatlabLabScenario,
  selectSourcesLabScenario,
  selectUxLabJourney,
  sourcesLabScenarios,
  type SourcesLabScenario,
  type UxLabJourney,
  type UxLabControlPosition,
  uxLabJourneys,
} from "./state";

const VIEWPORT_MARGIN = 8;
const MATLAB_RUNTIME_PATH = "ux-lab-fixtures/matlab/fake-runtime/matlab";

function useActiveThreadRef(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  return useMemo(() => {
    if (routeTarget?.kind === "server") return routeTarget.threadRef;
    if (routeTarget?.kind === "draft" && draftSession) {
      return {
        environmentId: draftSession.environmentId,
        threadId: draftSession.threadId,
      };
    }
    return null;
  }, [draftSession, routeTarget]);
}

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
    readonly suppressClick: boolean;
    moved: boolean;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  const activeThreadRef = useActiveThreadRef();
  const activeJourney = readUxLabJourney();
  const activeSourcesScenario = readSourcesLabScenario();
  const activeMatlabScenario = readMatlabLabScenario();
  const matlabScenario = matlabLabScenarioDefinition(activeMatlabScenario);

  useEffect(() => {
    if (activeJourney !== "matlab-run-file" || activeThreadRef === null) return;
    useRightPanelStore.getState().openFile(activeThreadRef, matlabScenario.relativePath);
  }, [activeJourney, activeThreadRef, matlabScenario.relativePath]);

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
      ignoreClickRef.current = drag.moved && drag.suppressClick;
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

  const startDragging = (event: ReactMouseEvent<HTMLElement>, suppressClick: boolean) => {
    if (event.button !== 0 || rootRef.current === null) return;
    const bounds = rootRef.current.getBoundingClientRect();
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: bounds.left,
      originY: bounds.top,
      suppressClick,
      moved: false,
    };
    event.preventDefault();
  };

  const anchorX = position?.x ?? 16;
  const anchorY = position?.y ?? window.innerHeight - 52;
  const openPanelToLeft = anchorX > window.innerWidth / 2;
  const openPanelBelow = anchorY < 320;

  return (
    <div
      className="pointer-events-none fixed z-[100]"
      ref={rootRef}
      style={position === null ? { left: 16, bottom: 16 } : { left: position.x, top: position.y }}
    >
      {open ? (
        <section
          className={`pointer-events-auto absolute w-72 rounded-xl border border-border bg-background/95 p-3 text-foreground shadow-xl backdrop-blur ${
            openPanelToLeft ? "right-0" : "left-0"
          } ${openPanelBelow ? "top-[calc(100%+0.5rem)]" : "bottom-[calc(100%+0.5rem)]"}`}
        >
          <header
            className="mb-3 flex cursor-grab touch-none items-start justify-between gap-3 select-none active:cursor-grabbing"
            onMouseDown={(event) => startDragging(event, false)}
            title="Drag to move"
          >
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
              onMouseDown={(event) => event.stopPropagation()}
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
            id="ux-lab-journey"
            onChange={(event) => selectUxLabJourney(event.currentTarget.value as UxLabJourney)}
            value={activeJourney}
          >
            {uxLabJourneys.map((journey) => (
              <option key={journey.value} value={journey.value}>
                {journey.label}
              </option>
            ))}
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
            onChange={(event) => {
              if (activeJourney === "zotero-sources") {
                selectSourcesLabScenario(event.currentTarget.value as SourcesLabScenario);
              } else {
                selectMatlabLabScenario(event.currentTarget.value as MatlabLabScenario);
              }
            }}
            value={
              activeJourney === "zotero-sources" ? activeSourcesScenario : activeMatlabScenario
            }
          >
            {(activeJourney === "zotero-sources" ? sourcesLabScenarios : matlabLabScenarios).map(
              (scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label}
                </option>
              ),
            )}
          </select>

          {activeJourney === "matlab-run-file" ? (
            <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
              <p className="leading-relaxed text-muted-foreground">
                The real file editor opens this synthetic source automatically. Run it with the
                production MATLAB panel below the editor.
              </p>
              <div>
                <p className="font-medium">Fixture</p>
                <code className="mt-0.5 block break-all text-[11px] text-muted-foreground">
                  {matlabScenario.relativePath}
                </code>
              </div>
              <div>
                <p className="font-medium">Synthetic runtime</p>
                <code className="mt-0.5 block break-all text-[11px] text-muted-foreground">
                  {MATLAB_RUNTIME_PATH}
                </code>
              </div>
            </div>
          ) : null}
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
        onMouseDown={(event) => startDragging(event, true)}
        size="sm"
        title="Drag to move · Click to open"
      >
        <FlaskConical className="size-4" aria-hidden="true" />
        UX Lab
      </Button>
    </div>
  );
}
