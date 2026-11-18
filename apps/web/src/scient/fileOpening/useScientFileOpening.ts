import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRef } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { openFileInPreview } from "~/browser/openFileInPreview";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { workspaceFileHostPath } from "~/components/files/filePath";

import { shouldOpenInBrowserByDefault } from "./fileOpeningPolicy";

export function useScientFileOpening(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot: string | null;
  readonly openSource: (relativePath: string) => void;
}): (relativePath: string) => void {
  const { threadRef, workspaceRoot, openSource } = input;
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef?.environmentId ?? null);
  // Each open mints a new URL: the tab would otherwise load the cached copy of an edited file.
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  // A later open supersedes an earlier one still minting its URL, so it cannot take focus.
  const latestOpen = useRef(0);

  return (relativePath: string) => {
    if (!threadRef || !workspaceRoot) return;
    const open = ++latestOpen.current;
    const isCurrent = () => latestOpen.current === open;

    if (
      !shouldOpenInBrowserByDefault(relativePath) ||
      !isPreviewAvailableFor(threadRef.environmentId) ||
      environmentHttpBaseUrl === null
    ) {
      openSource(relativePath);
      return;
    }

    void (async () => {
      try {
        const result = await openFileInPreview({
          threadRef,
          workspaceRoot,
          filePath: workspaceFileHostPath(relativePath, workspaceRoot),
          httpBaseUrl: environmentHttpBaseUrl,
          createAssetUrl,
          openPreview,
          isCurrent,
        });
        if (result._tag === "Success" || isAtomCommandInterrupted(result) || !isCurrent()) return;

        openSource(relativePath);
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to preview HTML",
            description: `${error instanceof Error ? error.message : "An error occurred."} Opened the source instead.`,
          }),
        );
      } catch (cause) {
        if (!isCurrent()) return;
        openSource(relativePath);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to preview HTML",
            description: `${cause instanceof Error ? cause.message : "An error occurred."} Opened the source instead.`,
          }),
        );
      }
    })();
  };
}
