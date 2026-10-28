import { FILL_PREVIEW_VIEWPORT, type ScopedThreadRef } from "@t3tools/contracts";
import { previewPdfAssetUrl } from "@t3tools/shared/preview";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useChatCanvas } from "../chat/ChatCanvasContext";
import type { ChatCanvasPreview } from "../chat/chatCanvasLayout";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import {
  findActiveBrowserRecordingRuntimeTabId,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
  serverPictureInPictureKey,
  supportsServerPictureInPicture,
  useServerPictureInPictureKey,
} from "~/browser/serverPictureInPicture";
import { useBrowserLayoutZoomFactor } from "~/browser/useBrowserLayoutZoomFactor";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  type PreviewMiniPlayerContent,
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerState,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDeviceState } from "~/state/device";

import { DeviceStreamView } from "../device/DeviceStreamView";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { Atom } from "effect/reactivity";
import { deviceScreenKey, deviceStreamScreenAtom } from "../device/deviceStreamSession";
import type { PreviewStreamViewport } from "@t3tools/client-runtime/preview/server-browser-stream";
import { previewBridge } from "./previewBridge";
// SCIENT-FORK:START
import {
  FloatingStaticArtifactActions,
  type Layout,
  miniPlayerKeyDownHandler,
  miniPlayerResizer,
  resolveMiniPlayerShellFrame,
  useMiniPlayerMeasuredLayout,
} from "./ScientMiniPlayerParts";
import { StaticAssetImageSurface } from "./StaticAssetImageSurface";
// SCIENT-FORK:END
import { showPreviewPopup } from "./showPreviewPopup";
import {
  clampPreviewMiniPlayerPosition,
  NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
  moved: boolean;
}

const HANDLE_TAP_SLOP_PX = 6;

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  /**
   * The docked composer overlay. Only read when the player lays itself out:
   * inside a chat canvas the canvas already measures the composer.
   */
  readonly composerOverlayElement?: HTMLElement | null | undefined;
}

const frameCornerRadius = () => PREVIEW_MINI_PLAYER_CORNER_RADIUS;

const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: BrowserViewportResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

// What the stream reports about its source. It lives outside the player so the
// chat canvas lays out the frame from the same source size the player uses. One
// slot is enough, since only the shown thread renders a player, and it keeps the
// store from collecting an entry for every tab a session ever streamed.
const useStreamedSourceSize = create<{
  readonly key: string;
  readonly viewport: PreviewStreamViewport;
} | null>(() => null);

const NO_DEVICE_SCREEN_ATOM = Atom.make<DeviceScreenSize | null>(null).pipe(
  Atom.withLabel("device-stream-screen:none"),
);

const streamedSourceKey = (threadRef: ScopedThreadRef, contentId: string) =>
  `${scopedThreadKey(threadRef)}\u0000${contentId}`;

// The mini player's device stream view, named so the canvas can read the
// screen size that view reports.
const miniPlayerDeviceViewId = (
  threadRef: ScopedThreadRef,
  source: Extract<PreviewMiniPlayerContent, { kind: "device" }>,
) =>
  `preview-mini-player\u0000${scopedThreadKey(threadRef)}\u0000${deviceScreenKey(threadRef.environmentId, source.hostId, source.deviceId)}`;

function useBrowserMiniPlayerSource(
  threadRef: ScopedThreadRef | null,
  content: Extract<PreviewMiniPlayerContent, { kind: "browser" }> | null,
) {
  const tabId = content?.tabId ?? null;
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = tabId === null ? null : (previewState.sessions[tabId] ?? null);
  const runtimeTabId =
    threadRef && tabId !== null
      ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
      : null;
  const desktopOverlay = tabId === null ? null : (previewState.desktopByTabId[tabId] ?? null);
  const layoutZoomFactor = useBrowserLayoutZoomFactor(desktopOverlay?.zoomFactor ?? 1);
  const fittedSourceContent = useBrowserSurfaceStore((state) =>
    runtimeTabId === null ? null : (state.byTabId[runtimeTabId]?.fittedSourceContent ?? null),
  );
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverTab =
    threadRef !== null &&
    snapshot?.runtime === "server" &&
    !rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot);
  const streamViewport = useStreamedSourceSize((state) =>
    threadRef && content !== null && state?.key === streamedSourceKey(threadRef, content.id)
      ? state.viewport
      : null,
  );
  const sourceSize: PreviewMiniPlayerSize =
    serverTab && streamViewport
      ? streamViewport
      : resolvePreviewMiniPlayerSourceSize(
          snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
          fittedSourceContent,
          layoutZoomFactor,
        );
  return { serverEpoch: previewState.serverEpoch, snapshot, desktopOverlay, serverTab, sourceSize };
}

/** The mini player as the chat canvas lays it out; null when no player renders. */
export function useThreadPreviewCanvasSource(
  threadRef: ScopedThreadRef | null,
  miniPlayer: PreviewMiniPlayerState | null,
): ChatCanvasPreview | null {
  const content = miniPlayer?.content ?? null;
  const browser = useBrowserMiniPlayerSource(
    threadRef,
    content?.kind === "browser" ? content : null,
  );
  const screen = useAtomValue(
    threadRef && content?.kind === "device"
      ? deviceStreamScreenAtom(miniPlayerDeviceViewId(threadRef, content))
      : NO_DEVICE_SCREEN_ATOM,
  );
  if (!miniPlayer || !content) return null;
  // SCIENT-FORK:START — static artifacts float in a portal and lay themselves out.
  if (content.kind === "static-artifact") return null;
  // SCIENT-FORK:END
  if (content.kind === "browser" && !browser.snapshot) return null;
  return {
    key: content.id,
    width: miniPlayer.size?.width ?? null,
    position: miniPlayer.position,
    lastInteraction: miniPlayer.lastInteraction,
    source:
      content.kind === "browser"
        ? browser.sourceSize
        : resolveDeviceMiniPlayerSourceSize(content.platform, screen),
  };
}

/** Floats the thread's browser tab, device stream, or scientific artifact over chat. */
export function ThreadPreviewMiniPlayer({
  threadRef,
  miniPlayer,
  composerOverlayElement = null,
}: Props) {
  const { content } = miniPlayer;
  if (content.kind === "browser") {
    return (
      <BrowserMiniPlayer
        key={content.id}
        threadRef={threadRef}
        tabId={content.tabId}
        miniPlayer={miniPlayer}
        composerOverlayElement={composerOverlayElement}
      />
    );
  }
  if (content.kind === "device") {
    return (
      <DeviceMiniPlayer
        key={content.id}
        threadRef={threadRef}
        source={content}
        miniPlayer={miniPlayer}
        composerOverlayElement={composerOverlayElement}
      />
    );
  }
  if (content.kind === "static-artifact") {
    return (
      <StaticArtifactMiniPlayer
        key={content.id}
        threadRef={threadRef}
        artifact={content.artifact}
        miniPlayer={miniPlayer}
      />
    );
  }
  return null;
}

function BrowserMiniPlayer({
  threadRef,
  tabId,
  miniPlayer,
  composerOverlayElement,
}: Props & { readonly tabId: string }) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const content = miniPlayer.content.kind === "browser" ? miniPlayer.content : null;
  const { serverEpoch, snapshot, desktopOverlay, serverTab, sourceSize } =
    useBrowserMiniPlayerSource(threadRef, content);
  const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
  const recordingTabIds = useActiveBrowserRecordingTabIds();
  const recording =
    recordingTabIds.has(runtimeTabId) ||
    findActiveBrowserRecordingRuntimeTabId(threadRef, tabId) !== null;
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const serverPictureInPicture =
    useServerPictureInPictureKey() === serverPictureInPictureKey(threadRef.threadId, tabId);
  const viewportKey = streamedSourceKey(threadRef, miniPlayer.content.id);

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = async () => {
    try {
      if (serverTab) {
        if (serverPictureInPicture) closeServerPictureInPicture();
        else
          await openServerPictureInPicture({
            ...threadRef,
            tabId,
            seed: serverSurfaceRef.current?.canvas() ?? null,
          });
      } else if (previewBridge) {
        const operation = desktopOverlay?.pictureInPicture
          ? previewBridge.pictureInPicture.close
          : previewBridge.pictureInPicture.open;
        await operation(runtimeTabId);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: serverTab ? "Unable to pop out preview" : "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  if (!snapshot) return null;
  const pdfUrl =
    snapshot.navStatus._tag === "Success"
      ? previewPdfAssetUrl(snapshot.navStatus.url, httpBaseUrl)
      : null;
  const poppedOut = serverTab ? serverPictureInPicture : Boolean(desktopOverlay?.pictureInPicture);
  const canPopOut = serverTab
    ? poppedOut || (pdfUrl === null && supportsServerPictureInPicture())
    : true;

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      composerOverlayElement={composerOverlayElement}
      label="Floating browser preview"
      recording={recording}
      onOpenInPanel={openInPanel}
      pillActions={
        canPopOut ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={poppedOut ? "secondary" : "ghost"}
                  size="icon-xs"
                  aria-label={
                    poppedOut ? "Close popped-out preview" : "Pop preview into separate window"
                  }
                  disabled={!serverTab && !desktopOverlay?.hasWebContents}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={toggleNativePictureInPicture}
                />
              }
            >
              <PictureInPicture2 />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {poppedOut ? "Close separate window" : "Pop into separate window"}
            </TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {(frame) =>
        serverTab ? (
          <div
            className="pointer-events-auto absolute inset-0 overflow-hidden rounded-[inherit]"
            style={{ zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX }}
          >
            <ServerBrowserSurface
              documentRuntimeTabId={runtimeTabId}
              ref={serverSurfaceRef}
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              tabId={tabId}
              pdfUrl={pdfUrl}
              visible
              followSize={false}
              controlPosition="bottom"
              onViewport={(viewport) =>
                useStreamedSourceSize.setState(
                  (state) =>
                    state?.key === viewportKey &&
                    state.viewport.width === viewport.width &&
                    state.viewport.height === viewport.height
                      ? state
                      : { key: viewportKey, viewport },
                  true,
                )
              }
              onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId, "floating")}
              className="size-full"
            />
          </div>
        ) : (
          <>
            <BrowserSurfaceSlot
              tabId={runtimeTabId}
              visible={Boolean(desktopOverlay?.hasWebContents)}
              cornerRadius={PREVIEW_MINI_PLAYER_CORNER_RADIUS}
              zIndex={PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}
              fitSourceContent
              layoutVersion={`${frame.x}:${frame.y}`}
              className="absolute inset-0"
            />
            {!desktopOverlay?.hasWebContents ? (
              <div className="pointer-events-none absolute inset-0 z-[49] flex items-center justify-center rounded-[inherit] bg-muted text-xs text-muted-foreground">
                Reconnecting preview…
              </div>
            ) : null}
          </>
        )
      }
    </MiniPlayerShell>
  );
}

function DeviceMiniPlayer({
  threadRef,
  source,
  miniPlayer,
  composerOverlayElement,
}: Props & { readonly source: Extract<PreviewMiniPlayerContent, { kind: "device" }> }) {
  const { state: deviceState } = useDeviceState(threadRef.environmentId);
  const viewId = miniPlayerDeviceViewId(threadRef, source);
  const screen = useAtomValue(deviceStreamScreenAtom(viewId));
  const sourceSize = resolveDeviceMiniPlayerSourceSize(source.platform, screen);
  const device = deviceState.devices.find(
    (entry) => entry.hostId === source.hostId && entry.id === source.deviceId,
  );
  const host = deviceState.hosts.find((entry) => entry.id === source.hostId);
  const hostLabel = host?.label ?? "Device host";
  const cornerRadius = (player: PreviewMiniPlayerSize) =>
    resolveDeviceMiniPlayerCornerRadius(source.platform, player);

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openDevice(threadRef, {
      hostId: source.hostId,
      deviceId: source.deviceId,
      platform: source.platform,
      name: source.name,
    });
  };

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      composerOverlayElement={composerOverlayElement}
      label="Floating device preview"
      onOpenInPanel={openInPanel}
      cornerRadius={cornerRadius}
    >
      {() => (
        <div
          className="pointer-events-auto absolute inset-0 overflow-hidden rounded-[inherit]"
          style={{ zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX }}
        >
          <DeviceStreamView
            environmentId={threadRef.environmentId}
            platform={source.platform}
            deviceId={source.deviceId}
            hostId={source.hostId}
            deviceName={device?.name ?? source.name}
            deviceDescription={`${hostLabel} · ${device?.version ?? source.platform}`}
            visible
            viewId={viewId}
            serveSimOnly={host?.kind === "simlock"}
          />
        </div>
      )}
    </MiniPlayerShell>
  );
}

function StaticArtifactMiniPlayer({
  threadRef,
  artifact,
  miniPlayer,
}: Props & { readonly artifact: PreviewStaticImageSurfaceDescriptor }) {
  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openScientArtifact(threadRef, artifact);
  };

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={PREVIEW_MINI_PLAYER_DEFAULT_SIZE}
      label="Floating scientific artifact"
      onOpenInPanel={openInPanel}
      freeSize
      fixed
      pillActions={
        <FloatingStaticArtifactActions
          artifact={artifact}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />
      }
    >
      {() => (
        <StaticAssetImageSurface
          environmentId={threadRef.environmentId}
          image={artifact}
          className="absolute inset-0 z-[48] overflow-hidden rounded-[inherit]"
        />
      )}
    </MiniPlayerShell>
  );
}

/** Match native clipping and DOM radii to align their separately composited edges. */
function MiniPlayerShell({
  threadRef,
  miniPlayer,
  sourceSize,
  composerOverlayElement,
  label,
  onOpenInPanel,
  pillActions,
  recording = false,
  cornerRadius = frameCornerRadius,
  freeSize = false,
  fixed = false,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  readonly sourceSize: PreviewMiniPlayerSize;
  readonly composerOverlayElement?: HTMLElement | null | undefined;
  readonly label: string;
  readonly onOpenInPanel: () => void;
  readonly pillActions?: ReactNode;
  readonly recording?: boolean;
  /** A free-sized player keeps its own height instead of the source ratio. */
  readonly freeSize?: boolean;
  /** A portaled player floats over the page instead of inside the chat canvas. */
  readonly fixed?: boolean;
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const canvas = useChatCanvas();
  const contentId = miniPlayer.content.id;
  // Touch toggles the pill after the tap's click so that click cannot land on the newly opened pill.
  const [pillOpen, setPillOpen] = useState(false);
  const handleTappedRef = useRef(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document pointerdown listener closes the open pill on an outside press
  useEffect(() => {
    if (!pillOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && handleRef.current?.contains(event.target)) return;
      setPillOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [pillOpen]);
  // Inside a chat canvas the canvas owns the lane geometry (useThreadPreviewCanvasSource),
  // so it also resolves the frame; a portaled or canvas-less player lays itself out.
  const canvasFrame =
    !freeSize && !fixed && canvas?.previewKey === contentId ? canvas.layout.frame : null;

  const container = canvasFrame ? (canvas?.container ?? null) : (layout?.container ?? null);
  const obstacles = canvasFrame ? NO_PREVIEW_MINI_PLAYER_OBSTACLES : (layout?.obstacles ?? null);

  // SCIENT-FORK:START — free-sized and self-laid-out players resolve their own frame
  const frame = resolveMiniPlayerShellFrame({
    canvasFrame,
    container,
    obstacles,
    freeSize,
    miniPlayer,
    sourceSize,
  });
  // SCIENT-FORK:END

  const radius = frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  const pillInset = Math.max(8, Math.round(radius * 0.55));

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  // SCIENT-FORK:START — self layout, free resizing and keyboard moves
  useMiniPlayerMeasuredLayout(containerRef, composerOverlayElement, canvasFrame, setLayout);
  const resizeFrom = miniPlayerResizer({
    container,
    obstacles,
    freeSize,
    sourceSize,
    threadRef,
    contentId,
  });
  // SCIENT-FORK:END

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container || !obstacles) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    if (!gesture.moved && Math.hypot(delta.x, delta.y) < HANDLE_TAP_SLOP_PX) return;
    gesture.moved = true;
    const store = usePreviewMiniPlayerStore.getState();
    if (gesture.direction === null) {
      store.move(
        threadRef,
        contentId,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
          // SCIENT-FORK:START — a self-laid-out player avoids the composer it measured
          obstacles,
          // SCIENT-FORK:END
        ),
      );
      return;
    }
    resizeFrom(gesture.frame, gesture.direction, delta);
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    handleTappedRef.current =
      event.type === "pointerup" &&
      gesture.direction === null &&
      gesture.pointerType === "touch" &&
      !gesture.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // SCIENT-FORK:START
  const handleKeyDown = miniPlayerKeyDownHandler({
    frame,
    container,
    obstacles,
    resizeFrom,
    threadRef,
    contentId,
  });
  // SCIENT-FORK:END

  const player = (
    <div
      ref={containerRef}
      className={cn("pointer-events-none inset-0", fixed ? "fixed z-[45]" : "absolute")}
    >
      {frame ? (
        <section
          aria-label={label}
          data-preview-mini-player={contentId}
          className="pointer-events-none absolute select-none"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            borderRadius: radius,
          }}
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <div
            ref={handleRef}
            data-pill-open={pillOpen ? "" : undefined}
            className="group pointer-events-auto absolute z-[49] size-3 touch-none cursor-grab active:cursor-grabbing pointer-coarse:-m-2.5 pointer-coarse:size-8"
            style={{ right: pillInset, top: pillInset }}
            onPointerDown={(event) => beginGesture(event, null)}
            onPointerMove={handlePointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onClick={() => {
              if (!handleTappedRef.current) return;
              handleTappedRef.current = false;
              setPillOpen((open) => !open);
            }}
          >
            <div
              role={recording ? "status" : undefined}
              aria-label={recording ? "Recording preview" : undefined}
              aria-hidden={!recording}
              className="absolute right-0 top-0 size-2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-data-pill-open:opacity-0 pointer-coarse:right-2.5 pointer-coarse:top-2.5"
            >
              <span
                className={cn(
                  "block size-2 rounded-full shadow-sm ring-1 ring-background/70",
                  recording
                    ? "bg-destructive motion-safe:animate-status-pulse"
                    : "bg-foreground/25",
                )}
              />
            </div>
            <div
              className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-pill-open:pointer-events-auto group-data-pill-open:opacity-100 active:cursor-grabbing pointer-coarse:right-2.5 pointer-coarse:top-2.5"
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
              {recording ? (
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                  <span className="size-2 rounded-full bg-destructive motion-safe:animate-status-pulse" />
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Open preview in right panel"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={onOpenInPanel}
                    />
                  }
                >
                  <PanelRightIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Open in right panel</TooltipPopup>
              </Tooltip>
              {pillActions}
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

          <div className="absolute inset-0 z-[47] rounded-[inherit] bg-muted shadow-2xl/35" />
          {children(frame)}
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-[inherit] ring-1 ring-inset ring-border/80" />
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
  return fixed ? createPortal(player, document.body) : player;
}
