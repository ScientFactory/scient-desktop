// FILE: BrowserPictureInPicture.tsx
// Purpose: Hosts the existing browser panel in one movable, resizable in-chat surface.
// Layer: Chat route UI
// Depends on: pure floating-browser layout rules and the existing browser runtime surface.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import {
  type BrowserPictureInPictureIdentity,
  type BrowserPictureInPictureLayout,
  type BrowserPictureInPicturePoint,
  type BrowserPictureInPictureSize,
  FLOATING_BROWSER_FRAME_MARGIN,
  fitFloatingBrowserLayout,
  updateFloatingBrowserLayoutFromKey,
} from "~/browserPictureInPicture";
import { LayoutSidebarIcon, WindowIcon, XIcon } from "~/lib/icons";
import {
  createPanelResizeOverlay,
  dispatchPanelResizeOverlaySync,
  removePanelResizeOverlay,
} from "~/lib/panelResize";

import { IconButton } from "./ui/icon-button";

type FloatingBrowserAdjustmentKind = "move" | "resize";

interface FloatingBrowserAdjustmentState {
  readonly kind: FloatingBrowserAdjustmentKind;
  readonly pointerId: number;
  readonly identity: BrowserPictureInPictureIdentity;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startLeft: number;
  readonly startTop: number;
  readonly startWidth: number;
  readonly startHeight: number;
  nextLayout: BrowserPictureInPictureLayout;
  animationFrame: number | null;
  readonly restoreBodyCursor: string;
  readonly restoreBodyUserSelect: string;
  readonly pointerShield: HTMLDivElement;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerEnd: (event: PointerEvent) => void;
  readonly onWindowBlur: () => void;
}

interface BrowserPictureInPictureProps {
  identity: BrowserPictureInPictureIdentity;
  position: BrowserPictureInPicturePoint | null;
  size: BrowserPictureInPictureSize;
  children: ReactNode;
  onLayoutCommit: (
    identity: BrowserPictureInPictureIdentity,
    layout: BrowserPictureInPictureLayout,
  ) => void;
  onClose: (identity: BrowserPictureInPictureIdentity) => void;
  onReturnToDock: (identity: BrowserPictureInPictureIdentity) => void;
}

function identitiesEqual(
  left: BrowserPictureInPictureIdentity,
  right: BrowserPictureInPictureIdentity,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.paneId === right.paneId &&
    left.tabId === right.tabId &&
    left.generation === right.generation
  );
}

function layoutsEqual(
  left: BrowserPictureInPictureLayout,
  right: BrowserPictureInPictureLayout,
): boolean {
  return (
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.size.width === right.size.width &&
    left.size.height === right.size.height
  );
}

function parentAreaFor(root: HTMLElement): BrowserPictureInPictureSize | null {
  const parent = root.offsetParent;
  return parent instanceof HTMLElement
    ? { width: parent.clientWidth, height: parent.clientHeight }
    : null;
}

export function BrowserPictureInPicture(props: BrowserPictureInPictureProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const adjustmentRef = useRef<FloatingBrowserAdjustmentState | null>(null);
  const workspaceFrameRef = useRef<number | null>(null);
  const focusedOnMountRef = useRef(false);
  const identityRef = useRef(props.identity);
  identityRef.current = props.identity;
  const onLayoutCommitRef = useRef(props.onLayoutCommit);
  onLayoutCommitRef.current = props.onLayoutCommit;
  const requestedLayoutRef = useRef({ position: props.position, size: props.size });
  requestedLayoutRef.current = { position: props.position, size: props.size };
  const layoutRef = useRef<BrowserPictureInPictureLayout>({
    position: props.position ?? {
      x: FLOATING_BROWSER_FRAME_MARGIN,
      y: FLOATING_BROWSER_FRAME_MARGIN,
    },
    size: props.size,
  });

  const writeLayout = useCallback(
    (identity: BrowserPictureInPictureIdentity, layout: BrowserPictureInPictureLayout) => {
      if (!identitiesEqual(identityRef.current, identity)) return false;
      const root = rootRef.current;
      if (!root) return false;

      const changed = !layoutsEqual(layoutRef.current, layout);
      layoutRef.current = layout;
      if (changed) {
        root.style.removeProperty("right");
        root.style.left = `${layout.position.x}px`;
        root.style.top = `${layout.position.y}px`;
        root.style.width = `${layout.size.width}px`;
        root.style.height = `${layout.size.height}px`;
        dispatchPanelResizeOverlaySync();
      }
      return true;
    },
    [],
  );

  const finishAdjustment = useCallback(
    (commit: boolean, pointerId?: number) => {
      const adjustment = adjustmentRef.current;
      if (!adjustment || (pointerId !== undefined && adjustment.pointerId !== pointerId)) return;

      if (adjustment.animationFrame !== null) {
        window.cancelAnimationFrame(adjustment.animationFrame);
      }
      const current = identitiesEqual(identityRef.current, adjustment.identity);
      if (current) writeLayout(adjustment.identity, adjustment.nextLayout);

      window.removeEventListener("pointermove", adjustment.onPointerMove);
      window.removeEventListener("pointerup", adjustment.onPointerEnd);
      window.removeEventListener("pointercancel", adjustment.onPointerEnd);
      window.removeEventListener("blur", adjustment.onWindowBlur);
      removePanelResizeOverlay(adjustment.pointerShield);
      document.body.style.cursor = adjustment.restoreBodyCursor;
      document.body.style.userSelect = adjustment.restoreBodyUserSelect;
      adjustmentRef.current = null;

      if (commit && current) {
        onLayoutCommitRef.current(adjustment.identity, adjustment.nextLayout);
      }
    },
    [writeLayout],
  );

  const beginAdjustment = useCallback(
    (kind: FloatingBrowserAdjustmentKind, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const root = rootRef.current;
      const parentArea = root ? parentAreaFor(root) : null;
      if (!root || !parentArea) return;

      event.preventDefault();
      event.stopPropagation();
      finishAdjustment(false);

      const identity = identityRef.current;
      const start = fitFloatingBrowserLayout(layoutRef.current, parentArea);
      const cursor = kind === "move" ? "grabbing" : "nwse-resize";
      const pointerShield = createPanelResizeOverlay(cursor);
      let adjustment: FloatingBrowserAdjustmentState;
      const onPointerMove = (pointerEvent: PointerEvent) => {
        if (
          pointerEvent.pointerId !== adjustment.pointerId ||
          !identitiesEqual(identityRef.current, adjustment.identity)
        ) {
          return;
        }
        const currentRoot = rootRef.current;
        const currentArea = currentRoot ? parentAreaFor(currentRoot) : null;
        if (!currentArea) return;

        const horizontalChange = pointerEvent.clientX - adjustment.startClientX;
        const verticalChange = pointerEvent.clientY - adjustment.startClientY;
        const requested =
          adjustment.kind === "move"
            ? {
                position: {
                  x: adjustment.startLeft + horizontalChange,
                  y: adjustment.startTop + verticalChange,
                },
                size: { width: adjustment.startWidth, height: adjustment.startHeight },
              }
            : {
                position: { x: adjustment.startLeft, y: adjustment.startTop },
                size: {
                  width: adjustment.startWidth + horizontalChange,
                  height: adjustment.startHeight + verticalChange,
                },
              };
        adjustment.nextLayout = fitFloatingBrowserLayout(requested, currentArea);
        if (adjustment.animationFrame !== null) return;
        adjustment.animationFrame = window.requestAnimationFrame(() => {
          adjustment.animationFrame = null;
          writeLayout(adjustment.identity, adjustment.nextLayout);
        });
      };
      const onPointerEnd = (pointerEvent: PointerEvent) => {
        finishAdjustment(true, pointerEvent.pointerId);
      };
      const onWindowBlur = () => finishAdjustment(true);

      adjustment = {
        kind,
        pointerId: event.pointerId,
        identity,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: start.position.x,
        startTop: start.position.y,
        startWidth: start.size.width,
        startHeight: start.size.height,
        nextLayout: start,
        animationFrame: null,
        restoreBodyCursor: document.body.style.cursor,
        restoreBodyUserSelect: document.body.style.userSelect,
        pointerShield,
        onPointerMove,
        onPointerEnd,
        onWindowBlur,
      };
      adjustmentRef.current = adjustment;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
      window.addEventListener("blur", onWindowBlur);
    },
    [finishAdjustment, writeLayout],
  );

  useEffect(() => () => finishAdjustment(false), [finishAdjustment]);

  // A tab handoff increments generation. Ending the old gesture here prevents an animation
  // frame from mutating the replacement browser surface before it paints.
  useLayoutEffect(() => {
    finishAdjustment(false);
  }, [finishAdjustment, props.identity.generation]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const identity = identityRef.current;
    const requested = requestedLayoutRef.current;
    const initial = fitFloatingBrowserLayout(
      {
        position: requested.position ?? { x: root.offsetLeft, y: root.offsetTop },
        size: requested.size,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
    );
    writeLayout(identity, initial);
    onLayoutCommitRef.current(identity, initial);

    if (!focusedOnMountRef.current) {
      root.focus({ preventScroll: true });
      focusedOnMountRef.current = true;
    }

    const fitToWorkspace = () => {
      if (workspaceFrameRef.current !== null) return;
      workspaceFrameRef.current = window.requestAnimationFrame(() => {
        workspaceFrameRef.current = null;
        if (!identitiesEqual(identityRef.current, identity)) return;
        const currentRoot = rootRef.current;
        const currentArea = currentRoot ? parentAreaFor(currentRoot) : null;
        if (!currentArea) return;
        const adjustment = adjustmentRef.current;
        const adjustmentIsCurrent =
          adjustment !== null && identitiesEqual(adjustment.identity, identity);
        const fitted = fitFloatingBrowserLayout(
          adjustmentIsCurrent ? adjustment.nextLayout : layoutRef.current,
          currentArea,
        );
        if (adjustmentIsCurrent) {
          adjustment.nextLayout = fitted;
        }
        if (!writeLayout(identity, fitted) || adjustment) return;
        onLayoutCommitRef.current(identity, fitted);
      });
    };

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitToWorkspace);
    observer?.observe(parent);
    window.addEventListener("resize", fitToWorkspace);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fitToWorkspace);
      if (workspaceFrameRef.current !== null) {
        window.cancelAnimationFrame(workspaceFrameRef.current);
        workspaceFrameRef.current = null;
      }
    };
  }, [props.identity.generation, writeLayout]);

  const handleKeyboardLayout = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const root = rootRef.current;
    const parentArea = root ? parentAreaFor(root) : null;
    if (!parentArea) return;
    const layout = updateFloatingBrowserLayoutFromKey({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      position: layoutRef.current.position,
      size: layoutRef.current.size,
      container: parentArea,
    });
    if (!layout) return;
    event.preventDefault();
    const identity = identityRef.current;
    if (writeLayout(identity, layout)) onLayoutCommitRef.current(identity, layout);
  };

  return (
    <section
      ref={rootRef}
      tabIndex={0}
      aria-label="Floating browser preview. Use arrow keys to move; Alt plus arrow keys to resize."
      data-browser-picture-in-picture={props.identity.tabId}
      className="pointer-events-auto absolute z-30 flex min-h-0 min-w-0 select-none flex-col overflow-hidden rounded-xl border border-border bg-[var(--color-background-surface)] shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={
        props.position
          ? {
              left: props.position.x,
              top: props.position.y,
              width: props.size.width,
              height: props.size.height,
            }
          : {
              right: FLOATING_BROWSER_FRAME_MARGIN,
              top: FLOATING_BROWSER_FRAME_MARGIN,
              width: props.size.width,
              height: props.size.height,
            }
      }
      onKeyDown={handleKeyboardLayout}
    >
      <div
        className="flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border px-2 active:cursor-grabbing"
        onPointerDown={(event) => beginAdjustment("move", event)}
      >
        <WindowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          Floating preview
        </span>
        <IconButton
          variant="chrome"
          size="icon-xs"
          label="Return preview to right panel"
          tooltip="Return to right panel"
          tooltipSide="bottom"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => props.onReturnToDock(props.identity)}
        >
          <LayoutSidebarIcon />
        </IconButton>
        <IconButton
          variant="chrome"
          size="icon-xs"
          label="Close floating preview"
          tooltip="Close floating preview"
          tooltipSide="bottom"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => props.onClose(props.identity)}
        >
          <XIcon />
        </IconButton>
      </div>
      <div data-native-browser-surface="true" className="relative min-h-0 flex-1 select-text">
        {props.children}
      </div>
      {/* Native local-HTML surfaces sit above renderer DOM, so the resize target stays in a
          dedicated footer rather than overlapping the browser's main-process-owned bounds. */}
      <div className="flex h-5 shrink-0 items-center justify-end border-t border-border bg-[var(--color-background-surface)]">
        <div
          aria-hidden="true"
          title="Resize floating preview"
          className="relative size-5 cursor-nwse-resize rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
          onPointerDown={(event) => beginAdjustment("resize", event)}
        />
      </div>
    </section>
  );
}
