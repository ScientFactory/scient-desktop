import { useEffect, useEffectEvent } from "react";

import type { AssetUrlState } from "~/assets/assetUrls";

/**
 * Reopening an image retries a failure cached by an earlier mount: the file may
 * exist now. A cached URL keeps upstream's no-re-mint-on-remount rule.
 */
export function useRetryCachedAssetFailure(assetUrl: AssetUrlState): void {
  const retry = useEffectEvent(() => {
    if (assetUrl._tag === "Failure" && assetUrl.reason !== "missing-file-access") {
      assetUrl.refresh();
    }
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Only a failure present at mount was cached by an earlier mount; retry it once.
  useEffect(() => retry(), []);
}
