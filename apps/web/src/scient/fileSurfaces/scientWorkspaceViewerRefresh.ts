import type { ScopedThreadRef } from "@t3tools/contracts";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef } from "react";

import type { AssetUrlState } from "~/assets/assetUrls";
import { fileSurfaceAssetResource } from "~/components/files/fileSurfaceAssetResource";

/*
 * Scient additions to the inherited workspace viewers (image, HTML/PDF page,
 * video, audio): the asset is named by the tab's own path, the viewer reloads
 * when the file's native watcher reports a change, and a failed load can be
 * retried.
 */

/** The asset a viewer loads, named by the tab's own path. */
export function useScientViewerResource(
  props: {
    readonly absolutePath: string;
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly threadRef: ScopedThreadRef;
  },
  /** The viewer shows the file as an HTML page. */
  htmlDocument?: boolean,
) {
  return useMemo(
    () =>
      fileSurfaceAssetResource({
        absolutePath: props.absolutePath,
        workspaceRoot: props.workspaceRoot,
        relativePath: props.relativePath,
        threadId: props.threadRef.threadId,
        ...(htmlDocument === undefined ? {} : { htmlDocument }),
      }),
    [
      htmlDocument,
      props.absolutePath,
      props.relativePath,
      props.threadRef.threadId,
      props.workspaceRoot,
    ],
  );
}

/**
 * Reloads the asset each time the file's native watcher advances refreshKey,
 * not on mount. Failed refreshes flow through the asset state and can be
 * retried from the viewer.
 */
export function useScientViewerRefreshKey(
  refreshKey: number,
  refresh: () => unknown,
  setFailedUrl?: Dispatch<SetStateAction<string | null>>,
): void {
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    setFailedUrl?.(null);
    void Promise.resolve(refresh()).catch(() => undefined);
  }, [refresh, refreshKey, setFailedUrl]);
}

/** Makes a reloaded asset URL differ from the one the viewer already loaded. */
export function scientViewerRevisionSuffix(assetUrl: AssetUrlState, refreshKey: number): string {
  return refreshKey === 0
    ? ""
    : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${refreshKey}`;
}

/** Retries a failed asset, staying busy until the renewed URL arrives. */
export function retryScientViewerAsset(
  refreshAssetUrl: () => Promise<unknown>,
  setRetrying: Dispatch<SetStateAction<boolean>>,
  onSettled?: () => void,
): void {
  setRetrying(true);
  void refreshAssetUrl()
    .catch(() => undefined)
    .finally(() => {
      setRetrying(false);
      onSettled?.();
    });
}
