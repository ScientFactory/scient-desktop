// FILE: BrowserPictureInPicture.tsx
// Purpose: Hosts the existing browser panel in one draggable, resizable in-chat mini-player.
// Layer: Chat route UI
// Depends on: pure browserPictureInPicture layout rules and existing browser runtime surface.
// Provenance: adapted from third-party donor commits f4c39432 and 32af2f00 (MIT); see
// THIRD_PARTY_NOTICES.md and apps/desktop/resources/THIRD_PARTY_NOTICES.md.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import {
  type BrowserPictureInPictureIdentity,
  type BrowserPictureInPictureLayout,
  type BrowserPictureInPicturePoint,
  type BrowserPictureInPictureSize,
  BROWSER_PIP_EDGE_GAP,
  clampBrowserPictureInPicturePosition,
  clampBrowserPictureInPictureSize,
  resolveBrowserPictureInPictureKeyboardLayout,
} from "~/browserPictureInPicture";
import { LayoutSidebarIcon, WindowIcon, XIcon } from "~/lib/icons";
import { dispatchPanelResizeOverlaySync } from "~/lib/panelResize";

import { IconButton } from "./ui/icon-button";

interface PointerOperation {
  readonly pointerId: number;
  readonly target: HTMLElement;
  readonly identity: BrowserPictureInPictureIdentity;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly layout: BrowserPictureInPictureLayout;
}

interface PendingLayout {
  readonly identity: BrowserPictureInPictureIdentity;
  readonly layout: BrowserPictureInPictureLayout;
  readonly commit: boolean;
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

function releasePointer(operation: PointerOperation | null): void {
  if (!operation) return;
  try {
    if (operation.target.hasPointerCapture(operation.pointerId)) {
      operation.target.releasePointerCapture(operation.pointerId);
    }
  } catch {
    // The surface may have unmounted during a route or browser-tab transition.
  }
}

export function BrowserPictureInPicture(props: BrowserPictureInPictureProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<PointerOperation | null>(null);
  const resizeRef = useRef<PointerOperation | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingLayoutRef = useRef<PendingLayout | null>(null);
  const initializedLayoutRef = useRef(false);
  const focusedOnMountRef = useRef(false);
  const identityRef = useRef(props.identity);
  identityRef.current = props.identity;
  const layoutRef = useRef<BrowserPictureInPictureLayout>({
    position: props.position ?? { x: BROWSER_PIP_EDGE_GAP, y: BROWSER_PIP_EDGE_GAP },
    size: props.size,
  });

  const applyLayout = (pending: PendingLayout) => {
    if (!identitiesEqual(identityRef.current, pending.identity)) return;
    const root = rootRef.current;
    if (!root) return;
    initializedLayoutRef.current = true;
    const changed = !layoutsEqual(layoutRef.current, pending.layout);
    layoutRef.current = pending.layout;
    if (changed) {
      root.style.removeProperty("right");
      root.style.left = `${pending.layout.position.x}px`;
      root.style.top = `${pending.layout.position.y}px`;
      root.style.width = `${pending.layout.size.width}px`;
      root.style.height = `${pending.layout.size.height}px`;
      // BrowserPanel listens for this shared event. One signal per animation frame keeps
      // main-owned local HTML WebContentsView bounds aligned with drag/parent clamping.
      dispatchPanelResizeOverlaySync();
    }
    if (pending.commit) {
      props.onLayoutCommit(pending.identity, pending.layout);
    }
  };

  const flushPendingLayout = (commit: boolean) => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingLayoutRef.current;
    pendingLayoutRef.current = null;
    if (pending) {
      applyLayout({ ...pending, commit: commit || pending.commit });
      return;
    }
    if (commit) {
      props.onLayoutCommit(identityRef.current, layoutRef.current);
    }
  };

  const scheduleLayout = (pending: PendingLayout) => {
    const previous = pendingLayoutRef.current;
    pendingLayoutRef.current = {
      ...pending,
      commit: pending.commit || previous?.commit === true,
    };
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingLayoutRef.current;
      pendingLayoutRef.current = null;
      if (next) applyLayout(next);
    });
  };

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      releasePointer(dragRef.current);
      releasePointer(resizeRef.current);
      frameRef.current = null;
      pendingLayoutRef.current = null;
      dragRef.current = null;
      resizeRef.current = null;
    };
  }, []);

  // A tab handoff increments generation. Cancel animation and pointer ownership in a layout
  // effect, before the replacement browser surface can paint or receive stale gesture work.
  useLayoutEffect(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    releasePointer(dragRef.current);
    releasePointer(resizeRef.current);
    frameRef.current = null;
    pendingLayoutRef.current = null;
    dragRef.current = null;
    resizeRef.current = null;
    initializedLayoutRef.current = false;
  }, [props.identity.generation]);

  useLayoutEffect(() => {
    const clampToParent = () => {
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const container = { width: parent.clientWidth, height: parent.clientHeight };
      const size = clampBrowserPictureInPictureSize(layoutRef.current.size, container);
      const position = clampBrowserPictureInPicturePosition(
        initializedLayoutRef.current
          ? layoutRef.current.position
          : (props.position ?? { x: root.offsetLeft, y: root.offsetTop }),
        container,
        size,
      );
      scheduleLayout({
        identity: identityRef.current,
        layout: { position, size },
        // A root ResizeObserver fires while pointer resizing changes the element's size.
        // Keep those updates local to the rAF pipeline and persist once on pointer release.
        commit: dragRef.current === null && resizeRef.current === null,
      });
    };

    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    // Focus enters the floating surface deterministically after the dock action disappears,
    // but a browser-tab generation handoff must not steal focus back from browser controls.
    if (!focusedOnMountRef.current) {
      root.focus({ preventScroll: true });
      focusedOnMountRef.current = true;
    }
    clampToParent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(clampToParent);
    observer.observe(root);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [props.identity.generation]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const operation: PointerOperation = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      identity: identityRef.current,
      pointerX: event.clientX,
      pointerY: event.clientY,
      layout: {
        position: {
          x: rootRect.left - parentRect.left,
          y: rootRect.top - parentRect.top,
        },
        size: { width: root.offsetWidth, height: root.offsetHeight },
      },
    };
    dragRef.current = operation;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const operation = dragRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !operation ||
      operation.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    scheduleLayout({
      identity: operation.identity,
      layout: {
        position: clampBrowserPictureInPicturePosition(
          {
            x: operation.layout.position.x + event.clientX - operation.pointerX,
            y: operation.layout.position.y + event.clientY - operation.pointerY,
          },
          { width: parent.clientWidth, height: parent.clientHeight },
          operation.layout.size,
        ),
        size: operation.layout.size,
      },
      commit: false,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const operation = dragRef.current;
    if (operation?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    flushPendingLayout(identitiesEqual(identityRef.current, operation.identity));
    releasePointer(operation);
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const operation: PointerOperation = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      identity: identityRef.current,
      pointerX: event.clientX,
      pointerY: event.clientY,
      layout: layoutRef.current,
    };
    resizeRef.current = operation;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const operation = resizeRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !operation ||
      operation.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    const container = { width: parent.clientWidth, height: parent.clientHeight };
    const size = clampBrowserPictureInPictureSize(
      {
        width: operation.layout.size.width + event.clientX - operation.pointerX,
        height: operation.layout.size.height + event.clientY - operation.pointerY,
      },
      container,
    );
    scheduleLayout({
      identity: operation.identity,
      layout: {
        position: clampBrowserPictureInPicturePosition(operation.layout.position, container, size),
        size,
      },
      commit: false,
    });
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const operation = resizeRef.current;
    if (operation?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    flushPendingLayout(identitiesEqual(identityRef.current, operation.identity));
    releasePointer(operation);
  };

  const handleKeyboardLayout = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const layout = resolveBrowserPictureInPictureKeyboardLayout({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      position: layoutRef.current.position,
      size: layoutRef.current.size,
      container: { width: parent.clientWidth, height: parent.clientHeight },
    });
    if (!layout) return;
    event.preventDefault();
    scheduleLayout({ identity: identityRef.current, layout, commit: true });
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
              right: BROWSER_PIP_EDGE_GAP,
              top: BROWSER_PIP_EDGE_GAP,
              width: props.size.width,
              height: props.size.height,
            }
      }
      onKeyDown={handleKeyboardLayout}
    >
      <div
        className="flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border px-2 active:cursor-grabbing"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
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
      {/* Keep the resize target outside the native browser bounds. Main-process-owned local
          HTML surfaces paint above renderer DOM, so an overlapping corner handle would be
          unreachable even though it looks correct for renderer-owned webviews. */}
      <div className="flex h-5 shrink-0 items-center justify-end border-t border-border bg-[var(--color-background-surface)]">
        <div
          aria-hidden="true"
          title="Resize floating preview"
          className="relative size-5 cursor-nwse-resize rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
        />
      </div>
    </section>
  );
}
