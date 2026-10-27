import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode, useLayoutEffect, useState } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useRendersServerTabNatively } from "~/browser/previewRuntime";
import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { observeResize } from "~/lib/observeResize";
import { useThreadPreviewState } from "~/previewStateStore";

/**
 * The sign-in's own browser tab, live inside the conversation. The slot borrows the tab's
 * surface from the panel or floating player while it is mounted and hands it back after.
 */
export function HandoffBrowser({
  environmentId,
  threadId,
  tabId,
  className,
  fallback,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly className: string;
  /** Shown when this client has no view of the tab (another device, or the tab closed). */
  readonly fallback: ReactNode;
}) {
  const threadRef = { environmentId, threadId };
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const nativeServerTab = useRendersServerTabNatively(environmentId, snapshot);
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const inView = useFullyInView(frame);
  if (!snapshot) return fallback;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  return (
    <div ref={setFrame} className={`relative ${className}`}>
      {snapshot.runtime === "server" && !nativeServerTab ? (
        <ServerBrowserSurface
          environmentId={environmentId}
          threadId={threadId}
          tabId={tabId}
          documentRuntimeTabId={runtimeTabId}
          visible
          followSize={false}
          controlPosition="bottom"
          className="size-full"
        />
      ) : (
        <>
          <BrowserSurfaceSlot
            tabId={runtimeTabId}
            visible={inView && Boolean(desktopOverlay?.hasWebContents)}
            fitSourceContent
            className="size-full"
          />
          {/* The page is a native layer over the app, so it can't be half-hidden by scrolling. */}
          {inView ? null : (
            <div className="absolute inset-0 flex items-start justify-center bg-muted/40 pt-8 text-xs text-muted-foreground">
              Scroll to bring the page into view
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Whether the element sits wholly inside its scroller and above the composer. */
function useFullyInView(element: HTMLElement | null) {
  const [inView, setInView] = useState(true);
  // oxlint-disable-next-line t3code/react-effect-budget -- Native surfaces can't clip; visibility follows layout, scrolling and the composer.
  useLayoutEffect(() => {
    if (!element) return;
    let scroller: HTMLElement | null = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const composer = document.querySelector('[data-chat-composer-stack="true"]');
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottom = Math.min(
        scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight,
        composer ? composer.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
      );
      setInView(rect.height > 0 && rect.top >= top - 1 && rect.bottom <= bottom + 1);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    const stopObserving = observeResize(scroller ? [element, scroller] : [element], schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      stopObserving();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [element]);
  return inView;
}
