import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { isCurrentPreviewRuntimeTab } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowserPdfExport,
  useEnvironmentSupportsServerBrowserPdfExport,
} from "~/state/entities";

import {
  resolveBrowserPdfExportOwner,
  type BrowserPdfExportOwner,
} from "./browserPdfExportOwnerModel";

export function useBrowserPdfExportOwner(
  environmentId: EnvironmentId,
  snapshot: PreviewSessionSnapshot | null,
  hasWebContents: boolean,
  serverEpoch: string | null,
): BrowserPdfExportOwner | null {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const supportsServerPdf = useEnvironmentSupportsServerBrowserPdfExport(environmentId);
  if (!snapshot) return null;
  return resolveBrowserPdfExportOwner({
    runtime: snapshot.runtime,
    nativeServerTab: rendersServerTabNatively(environmentId, primaryEnvironmentId, snapshot),
    hasWebContents,
    desktopAvailable: Boolean(previewBridge),
    supportsServerPdf,
    serverEpoch,
  });
}

export type BrowserPdfExportLease =
  | { readonly owner: "server"; readonly serverEpoch: string; readonly pageUrl: string }
  | { readonly owner: "desktop"; readonly serverEpoch: string | null; readonly pageUrl: string };

/** Resolve the actual current tab rather than accepting a caller's renderer choice. */
export function readBrowserPdfExportLease(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
): BrowserPdfExportLease | null {
  const preview = readThreadPreviewState(threadRef);
  const snapshot = preview.sessions[tabId];
  if (
    !snapshot ||
    snapshot.navStatus._tag !== "Success" ||
    !isCurrentPreviewRuntimeTab(threadRef, preview.serverEpoch, tabId, runtimeTabId)
  )
    return null;
  const owner = resolveBrowserPdfExportOwner({
    runtime: snapshot.runtime,
    nativeServerTab: rendersServerTabNatively(
      threadRef.environmentId,
      appAtomRegistry.get(primaryEnvironmentIdAtom),
      snapshot,
    ),
    hasWebContents: preview.desktopByTabId[tabId]?.hasWebContents === true,
    desktopAvailable: Boolean(previewBridge),
    supportsServerPdf: readEnvironmentSupportsServerBrowserPdfExport(threadRef.environmentId),
    serverEpoch: preview.serverEpoch,
  });
  if (owner === "server" && preview.serverEpoch !== null)
    return { owner, serverEpoch: preview.serverEpoch, pageUrl: snapshot.navStatus.url };
  return owner === "desktop"
    ? { owner, serverEpoch: preview.serverEpoch, pageUrl: snapshot.navStatus.url }
    : null;
}
