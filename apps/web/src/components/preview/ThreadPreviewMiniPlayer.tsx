"use client";

import {
  FILL_PREVIEW_VIEWPORT,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { createPortal } from "react-dom";
import { useAssetUrlState } from "~/assets/assetUrls";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { StaticAssetImageSurface } from "./StaticAssetImageSurface";
import { StaticImageCopyButton, StaticImageDownloadButton } from "./StaticImageActionButtons";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  type PreviewMiniPlayerSize,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  resolvePreviewMiniPlayerDefaultPosition,
  resizePreviewMiniPlayerRect,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly bottomInset?: number;
}

// Invisible grab zones straddling each edge; the cursor is the only affordance.
const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: BrowserViewportResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nesw-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

function FloatingStaticArtifactActions(props: {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const asset = useAssetUrlState(props.environmentId, props.artifact.resource);
  const assetUrl = asset._tag === "Success" ? asset.url : null;

  return (
    <>
      <StaticImageCopyButton assetUrl={assetUrl} threadRef={props.threadRef} />
      <StaticImageDownloadButton
        assetUrl={assetUrl}
        fileName={props.artifact.fileName}
        threadRef={props.threadRef}
      />
    </>
  );
}

export function ThreadPreviewMiniPlayer({ threadRef, bottomInset = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [container, setContainer] = useState<PreviewMiniPlayerSize | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const content = miniPlayer?.content;
  const contentId = content?.id ?? "";
  const tabId = content?.kind === "browser" ? content.tabId : null;
  const inset = content?.kind === "static-artifact" ? 0 : bottomInset;
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const hasSurface = content?.kind === "static-artifact" || snapshot !== null;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const fittedSourceContent = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.fittedSourceContent ?? null) : null,
  );
  const source = resolvePreviewMiniPlayerSourceSize(
    snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
    fittedSourceContent,
    desktopOverlay?.zoomFactor ?? 1,
  );
  const browserFrame =
    container && miniPlayer
      ? resolvePreviewMiniPlayerFrame({
          width: miniPlayer.size?.width ?? null,
          position: miniPlayer.position,
          source,
          container,
          bottomInset: inset,
        })
      : null;

  const artifactSize = container
    ? clampPreviewMiniPlayerSize(miniPlayer?.size ?? PREVIEW_MINI_PLAYER_DEFAULT_SIZE, container)
    : null;
  const frame =
    content?.kind === "static-artifact" && container && artifactSize
      ? {
          ...clampPreviewMiniPlayerPosition(
            miniPlayer?.position ??
              resolvePreviewMiniPlayerDefaultPosition(container, artifactSize),
            container,
            artifactSize,
          ),
          ...artifactSize,
        }
      : browserFrame;

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    if (content?.kind === "static-artifact") {
      useRightPanelStore.getState().openScientArtifact(threadRef, content.artifact);
    } else if (tabId) {
      useRightPanelStore.getState().openBrowser(threadRef, tabId);
    }
  };

  const toggleNativePictureInPicture = () => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      setContainer((current) =>
        current?.width === element.clientWidth && current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasSurface, contentId]);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    const store = usePreviewMiniPlayerStore.getState();
    if (gesture.direction === null) {
      store.move(
        threadRef,
        contentId,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
          inset,
        ),
      );
      return;
    }
    resizeFrom(gesture.frame, gesture.direction, delta);
  };

  const resizeFrom = (
    start: PreviewMiniPlayerFrame,
    direction: BrowserViewportResizeDirection,
    delta: { x: number; y: number },
  ) => {
    if (!container) return;
    const next =
      content?.kind === "static-artifact"
        ? resizePreviewMiniPlayerRect({
            rect: {
              position: { x: start.x, y: start.y },
              size: { width: start.width, height: start.height },
            },
            direction: direction
              .replace("north", "n")
              .replace("south", "s")
              .replace("east", "e")
              .replace(
                "west",
                "w",
              ) as import("./previewMiniPlayerLayout").PreviewMiniPlayerResizeDirection,
            delta,
            container,
          })
        : (() => {
            const resized = resizePreviewMiniPlayer({
              start,
              direction,
              delta,
              source,
              container,
              bottomInset: inset,
            });
            return {
              position: { x: resized.x, y: resized.y },
              size: { width: resized.width, height: resized.height },
            };
          })();
    usePreviewMiniPlayerStore.getState().setRect(threadRef, contentId, next);
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (!frame || !container) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!horizontal && !vertical) return;
    if (
      direction &&
      ((horizontal && !/east|west/.test(direction)) || (vertical && !/north|south/.test(direction)))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const step = direction ? (event.shiftKey ? 60 : 12) : event.shiftKey ? 80 : 8;
    const delta = {
      x: horizontal ? (event.key === "ArrowLeft" ? -step : step) : 0,
      y: vertical ? (event.key === "ArrowUp" ? -step : step) : 0,
    };
    if (direction) {
      resizeFrom(
        frame,
        horizontal
          ? direction.includes("west")
            ? "west"
            : "east"
          : direction.includes("north")
            ? "north"
            : "south",
        delta,
      );
    } else {
      usePreviewMiniPlayerStore
        .getState()
        .move(
          threadRef,
          contentId,
          clampPreviewMiniPlayerPosition(
            { x: frame.x + delta.x, y: frame.y + delta.y },
            container,
            frame,
            inset,
          ),
        );
    }
  };

  if (!content || (content.kind === "browser" && !snapshot)) return null;

  const player = (
    <div
      ref={containerRef}
      className={cn(
        "pointer-events-none inset-0",
        content.kind === "static-artifact" ? "fixed z-[45]" : "absolute",
      )}
    >
      {frame ? (
        <section
          aria-label="Floating preview"
          data-preview-mini-player={contentId}
          className="pointer-events-none absolute select-none"
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
          onKeyDownCapture={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="group pointer-events-auto absolute right-2 top-2 z-[49] size-3">
            <div
              aria-hidden="true"
              className="absolute right-0 top-0 size-2 rounded-full bg-foreground/25 shadow-sm ring-1 ring-background/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            />
            <div
              className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing"
              onPointerDown={(event) => beginGesture(event, null)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onLostPointerCapture={endGesture}
              role="toolbar"
              tabIndex={0}
              aria-label="Floating preview controls. Use arrow keys to move."
              onKeyDown={(event) => {
                if (event.target === event.currentTarget) handleKeyDown(event, null);
              }}
            >
              {content.kind === "static-artifact" ? (
                <FloatingStaticArtifactActions
                  artifact={content.artifact}
                  environmentId={threadRef.environmentId}
                  threadRef={threadRef}
                />
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Open preview in right panel"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={openInPanel}
                    />
                  }
                >
                  <PanelRightIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Open in right panel</TooltipPopup>
              </Tooltip>
              {content.kind === "browser" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
                        size="icon-xs"
                        aria-label={
                          desktopOverlay?.pictureInPicture
                            ? "Close popped-out preview"
                            : "Pop preview into separate window"
                        }
                        disabled={!desktopOverlay?.hasWebContents}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={toggleNativePictureInPicture}
                      />
                    }
                  >
                    <PictureInPicture2 />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {desktopOverlay?.pictureInPicture
                      ? "Close separate window"
                      : "Pop into separate window"}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close floating preview"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={close}
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Close floating preview</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          <div className="absolute inset-0 z-[47] rounded-xl bg-muted shadow-2xl/35" />
          {content.kind === "static-artifact" ? (
            <StaticAssetImageSurface
              environmentId={threadRef.environmentId}
              image={content.artifact}
              className="absolute inset-0 z-[48] rounded-xl overflow-hidden"
            />
          ) : (
            <BrowserSurfaceSlot
              tabId={runtimeTabId!}
              visible={Boolean(desktopOverlay?.hasWebContents)}
              cornerRadius={12}
              zIndex={PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}
              fitSourceContent
              layoutVersion={`${frame.x}:${frame.y}`}
              className="absolute inset-0"
            />
          )}
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-xl ring-1 ring-inset ring-border/80" />
          {content.kind === "browser" && !desktopOverlay?.hasWebContents ? (
            <div className="pointer-events-none absolute inset-0 z-[49] flex items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">
              Reconnecting preview…
            </div>
          ) : null}
          {RESIZE_HANDLES.map(({ direction, className }) => (
            <button
              type="button"
              key={direction}
              aria-label={`Resize floating preview from ${direction}`}
              data-preview-mini-player-resize={direction}
              className={cn("pointer-events-auto absolute z-[49] touch-none", className)}
              onPointerDown={(event) => beginGesture(event, direction)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onLostPointerCapture={endGesture}
              onKeyDown={(event) => handleKeyDown(event, direction)}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
  return content.kind === "static-artifact" ? createPortal(player, document.body) : player;
}
