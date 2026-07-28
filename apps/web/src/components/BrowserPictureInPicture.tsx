// FILE: BrowserPictureInPicture.tsx
// Purpose: Hosts the existing browser panel in one draggable, resizable in-chat mini-player.
// Layer: Chat route UI
// Depends on: pure browserPictureInPicture layout rules and existing browser runtime surface.

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import {
  type BrowserPictureInPictureIdentity,
  type BrowserPictureInPicturePoint,
  type BrowserPictureInPictureSize,
  BROWSER_PIP_EDGE_GAP,
  clampBrowserPictureInPicturePosition,
  clampBrowserPictureInPictureSize,
} from "~/browserPictureInPicture";
import { LayoutSidebarIcon, WindowIcon, XIcon } from "~/lib/icons";

import { IconButton } from "./ui/icon-button";

interface PointerOperation {
  readonly pointerId: number;
  readonly target: HTMLElement;
  readonly pointerX: number;
  readonly pointerY: number;
}

interface DragOperation extends PointerOperation {
  readonly playerX: number;
  readonly playerY: number;
}

interface ResizeOperation extends PointerOperation {
  readonly width: number;
  readonly height: number;
}

interface BrowserPictureInPictureProps {
  identity: BrowserPictureInPictureIdentity;
  position: BrowserPictureInPicturePoint | null;
  size: BrowserPictureInPictureSize;
  children: ReactNode;
  onMove: (
    identity: BrowserPictureInPictureIdentity,
    position: BrowserPictureInPicturePoint,
  ) => void;
  onResize: (identity: BrowserPictureInPictureIdentity, size: BrowserPictureInPictureSize) => void;
  onClose: (identity: BrowserPictureInPictureIdentity) => void;
  onReturnToDock: (identity: BrowserPictureInPictureIdentity) => void;
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
  const dragRef = useRef<DragOperation | null>(null);
  const resizeRef = useRef<ResizeOperation | null>(null);
  const positionRef = useRef(props.position);
  positionRef.current = props.position;

  useEffect(() => {
    return () => {
      releasePointer(dragRef.current);
      releasePointer(resizeRef.current);
      dragRef.current = null;
      resizeRef.current = null;
    };
  }, []);

  // A tab handoff increments generation. Cancel any gesture that started against the
  // previous surface so a late pointer event cannot move or resize the replacement tab.
  useEffect(() => {
    releasePointer(dragRef.current);
    releasePointer(resizeRef.current);
    dragRef.current = null;
    resizeRef.current = null;
  }, [props.identity.generation]);

  useLayoutEffect(() => {
    const clampToParent = () => {
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const container = { width: parent.clientWidth, height: parent.clientHeight };
      const nextSize = clampBrowserPictureInPictureSize(
        { width: root.offsetWidth, height: root.offsetHeight },
        container,
      );
      props.onResize(props.identity, nextSize);
      props.onMove(
        props.identity,
        clampBrowserPictureInPicturePosition(
          positionRef.current ?? { x: root.offsetLeft, y: root.offsetTop },
          container,
          nextSize,
        ),
      );
    };

    clampToParent();
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(clampToParent);
    observer.observe(root);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [props.identity, props.onMove, props.onResize]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!drag || drag.pointerId !== event.pointerId || !root || !(parent instanceof HTMLElement)) {
      return;
    }
    props.onMove(
      props.identity,
      clampBrowserPictureInPicturePosition(
        {
          x: drag.playerX + event.clientX - drag.pointerX,
          y: drag.playerY + event.clientY - drag.pointerY,
        },
        { width: parent.clientWidth, height: parent.clientHeight },
        { width: root.offsetWidth, height: root.offsetHeight },
      ),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    releasePointer(drag);
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: root.offsetWidth,
      height: root.offsetHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !resize ||
      resize.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    const container = { width: parent.clientWidth, height: parent.clientHeight };
    const nextSize = clampBrowserPictureInPictureSize(
      {
        width: resize.width + event.clientX - resize.pointerX,
        height: resize.height + event.clientY - resize.pointerY,
      },
      container,
    );
    props.onResize(props.identity, nextSize);
    props.onMove(
      props.identity,
      clampBrowserPictureInPicturePosition(
        props.position ?? { x: root.offsetLeft, y: root.offsetTop },
        container,
        nextSize,
      ),
    );
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (resize?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    releasePointer(resize);
  };

  return (
    <section
      ref={rootRef}
      aria-label="Floating browser preview"
      data-browser-picture-in-picture={props.identity.tabId}
      className="pointer-events-auto absolute z-30 flex min-h-0 min-w-0 select-none flex-col overflow-hidden rounded-xl border border-border bg-[var(--color-background-surface)] shadow-2xl"
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
        <button
          type="button"
          aria-label="Resize floating preview"
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
