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
import { workspaceFileHostPath } from "~/components/files/filePath";

import type { FileLinkResolution, OpenFileOptions } from "~/rightPanelStore";

import { announceResolvedLink } from "./announceResolvedLink";
import { shouldOpenInBrowserByDefault } from "./fileOpeningPolicy";

export function useScientFileOpening(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot: string | null;
  readonly openSource: (relativePath: string, line?: number, options?: OpenFileOptions) => void;
}): (relativePath: string, linkResolution?: FileLinkResolution) => void {
  const { threadRef, workspaceRoot, openSource } = input;
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef?.environmentId ?? null);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });

  return useCallback(
    (relativePath: string, linkResolution?: FileLinkResolution) => {
      if (!threadRef || !workspaceRoot) return;
      // A file the link did not name says so wherever it lands: on its tab in
      // the panel, or announced when it is a page in the browser.
      const openInPanel = () =>
        openSource(relativePath, undefined, linkResolution ? { linkResolution } : undefined);

      if (
        !shouldOpenInBrowserByDefault(relativePath) ||
        !isPreviewSupportedInRuntime() ||
        environmentHttpBaseUrl === null
      ) {
        openInPanel();
        return;
      }

      void (async () => {
        try {
          const result = await openFileInPreview({
            threadRef,
            workspaceRoot,
            relativePath,
            filePath: workspaceFileHostPath(relativePath, workspaceRoot),
            httpBaseUrl: environmentHttpBaseUrl,
            createAssetUrl,
            openPreview,
          });
          if (result._tag === "Success") {
            if (linkResolution) {
              announceResolvedLink({ path: relativePath, missingPath: linkResolution.missingPath });
            }
            return;
          }
          if (isAtomCommandInterrupted(result)) return;

          openInPanel();
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to preview HTML",
              description: `${error instanceof Error ? error.message : "An error occurred."} Opened the source instead.`,
            }),
          );
        } catch (cause) {
          openInPanel();
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
