import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { Button } from "~/components/ui/button";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { acquireDesktopTab } from "~/browser/desktopTabLifetime";
import { consumePreviewTakeover, createPreviewHostClaim } from "./previewHostOwnership";
import { previewWindowLocks } from "./previewTabPresence";

interface PreviewWindowTab {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly serverDriven: boolean;
}

/** Renders `children` (the tab's webview) only in the app window that hosts the tab. */
export function PreviewWindowHost(props: PreviewWindowTab & { readonly children: ReactNode }) {
  const locks = previewWindowLocks();
  if (!locks) return props.children;
  return <CoordinatedPreviewWindowHost {...props} locks={locks} />;
}

function CoordinatedPreviewWindowHost({
  locks,
  children,
  ...tab
}: PreviewWindowTab & { readonly locks: LockManager; readonly children: ReactNode }) {
  const { runtimeTabId, tabId } = tab;
  const displayed = useBrowserSurfaceStore((state) => {
    const presentation = state.byTabId[runtimeTabId];
    return presentation?.visible === true && presentation.rect !== null;
  });
  // Instances are keyed by runtime tab id, so the claim never needs to follow a new one.
  const [claim] = useState(() => createPreviewHostClaim(runtimeTabId, locks));
  const role = useSyncExternalStore(claim.subscribe, claim.role);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- queues this window in the Web Locks contest over the tab's webview while mounted
  useEffect(() => claim.start(), [claim]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the other app windows through Web Locks whether this window shows the tab
  useEffect(() => {
    void claim.setDisplayed(displayed).then(
      () => {
        // A window opened for this tab takes it even from a window that shows it.
        if (displayed && consumePreviewTakeover(tabId)) claim.showHere();
      },
      () => undefined,
    );
  }, [claim, displayed, tabId]);

  if (role === "host") return children;
  return (
    <>
      <PreviewTabFollower {...tab} />
      {role === "elsewhere" && displayed ? (
        <PreviewHostedElsewhere runtimeTabId={runtimeTabId} onShowHere={claim.showHere} />
      ) : null}
    </>
  );
}

/** Keeps the tab open and its toolbar state current while another window hosts the webview. */
function PreviewTabFollower({ threadRef, tabId, runtimeTabId, serverDriven }: PreviewWindowTab) {
  // Only the hosting window reports navigation to the server.
  usePreviewBridge({ threadRef, tabId, runtimeTabId, serverDriven: true });
  const { threadId } = threadRef;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leases the desktop preview tab so this window's release cannot close it under the hosting window
  useEffect(() => {
    const lease = acquireDesktopTab(runtimeTabId, serverDriven ? { threadId, tabId } : undefined);
    return lease.release;
  }, [runtimeTabId, serverDriven, tabId, threadId]);

  return null;
}

function PreviewHostedElsewhere(props: {
  readonly runtimeTabId: string;
  readonly onShowHere: () => void;
}) {
  const { rect, zIndex, cornerRadius } = useBrowserSurfaceStore(
    useShallow((state) => {
      const presentation = state.byTabId[props.runtimeTabId];
      return {
        rect: presentation?.rect ?? null,
        zIndex: presentation?.zIndex ?? 30,
        cornerRadius: presentation?.cornerRadius ?? 0,
      };
    }),
  );
  if (!rect) return null;
  return (
    <div
      className="fixed flex flex-col items-center justify-center gap-3 overflow-hidden bg-background p-4 text-center text-sm text-muted-foreground"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex,
        ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
      }}
      data-preview-hosted-elsewhere={props.runtimeTabId}
    >
      <p>This browser tab is open in another window.</p>
      <Button variant="outline" size="sm" onClick={props.onShowHere}>
        Show here
      </Button>
    </div>
  );
}
