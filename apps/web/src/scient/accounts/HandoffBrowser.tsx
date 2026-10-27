import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useRendersServerTabNatively } from "~/browser/previewRuntime";
import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
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
  if (!snapshot) return fallback;
  if (snapshot.runtime === "server" && !nativeServerTab)
    return (
      <div className={className}>
        <ServerBrowserSurface
          environmentId={environmentId}
          threadId={threadId}
          tabId={tabId}
          documentRuntimeTabId={previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)}
          visible
          followSize={false}
          controlPosition="bottom"
          className="size-full"
        />
      </div>
    );
  return (
    <div className={className}>
      <BrowserSurfaceSlot
        tabId={previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)}
        visible={Boolean(desktopOverlay?.hasWebContents)}
        fitSourceContent
        className="size-full"
      />
    </div>
  );
}
