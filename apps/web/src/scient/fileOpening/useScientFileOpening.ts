import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { msg } from "gt-react";

import { openFileInPreview } from "~/browser/openFileInPreview";
import { m } from "~/i18n/messages";
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
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });

  return (relativePath: string) => {
    if (!threadRef || !workspaceRoot) return;

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
        });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;

        openSource(relativePath);
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Unable to preview HTML")),
            description: m(
              msg("{error} Opened the source instead.", {
                error: error instanceof Error ? error.message : m(msg("An error occurred.")),
              }),
            ),
          }),
        );
      } catch (cause) {
        openSource(relativePath);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Unable to preview HTML")),
            description: m(
              msg("{error} Opened the source instead.", {
                error: cause instanceof Error ? cause.message : m(msg("An error occurred.")),
              }),
            ),
          }),
        );
      }
    })();
  };
}
