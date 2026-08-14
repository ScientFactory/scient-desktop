import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { openFileInPreview } from "~/browser/openFileInPreview";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { resolvePathLinkTarget } from "~/terminal-links";

import { shouldOpenInBrowserByDefault } from "./fileOpeningPolicy";

export function useScientFileOpening(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot: string | null;
  readonly openSource: (relativePath: string) => void;
}): (relativePath: string) => void {
  const { threadRef, workspaceRoot, openSource } = input;
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef?.environmentId ?? null);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });

  return useCallback(
    (relativePath: string) => {
      if (!threadRef || !workspaceRoot) return;

      if (
        !shouldOpenInBrowserByDefault(relativePath) ||
        !isPreviewSupportedInRuntime() ||
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
            relativePath,
            filePath: resolvePathLinkTarget(relativePath, workspaceRoot),
            httpBaseUrl: environmentHttpBaseUrl,
            createAssetUrl,
            openPreview,
          });
          if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;

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
    },
    [createAssetUrl, environmentHttpBaseUrl, openPreview, openSource, threadRef, workspaceRoot],
  );
}
