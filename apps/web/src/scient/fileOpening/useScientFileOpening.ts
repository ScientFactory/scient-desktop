import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type AtomCommandResult,
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
      void openFileWhereItBelongs({
        relativePath,
        linkResolution,
        openSource,
        openInBrowser:
          shouldOpenInBrowserByDefault(relativePath) &&
          isPreviewSupportedInRuntime() &&
          environmentHttpBaseUrl !== null
            ? () =>
                openFileInPreview({
                  threadRef,
                  workspaceRoot,
                  relativePath,
                  filePath: workspaceFileHostPath(relativePath, workspaceRoot),
                  httpBaseUrl: environmentHttpBaseUrl,
                  createAssetUrl,
                  openPreview,
                })
            : null,
      });
    },
    [createAssetUrl, environmentHttpBaseUrl, openPreview, openSource, threadRef, workspaceRoot],
  );
}

/**
 * Opens a file in the browser when it is a page and the browser is available,
 * otherwise in the files panel; a page the browser could not open falls back
 * to its source in the panel. A file that a link did not name says so wherever
 * it lands: on its tab in the panel, or announced when it is a page in the
 * browser, which has no tab to carry the note.
 */
export async function openFileWhereItBelongs(input: {
  readonly relativePath: string;
  readonly linkResolution: FileLinkResolution | undefined;
  readonly openSource: (relativePath: string, line?: number, options?: OpenFileOptions) => void;
  /** Opens the page in the browser; null when this file or runtime does not use it. */
  readonly openInBrowser: (() => Promise<AtomCommandResult<unknown, unknown>>) | null;
}): Promise<void> {
  const { linkResolution, relativePath } = input;
  const openInPanel = () =>
    input.openSource(relativePath, undefined, linkResolution ? { linkResolution } : undefined);
  if (input.openInBrowser === null) {
    openInPanel();
    return;
  }
  const openedSourceInstead = (cause: unknown) => {
    openInPanel();
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to preview HTML",
        description: `${cause instanceof Error ? cause.message : "An error occurred."} Opened the source instead.`,
      }),
    );
  };
  try {
    const result = await input.openInBrowser();
    if (result._tag === "Success") {
      if (linkResolution) {
        announceResolvedLink({ path: relativePath, missingPath: linkResolution.missingPath });
      }
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    openedSourceInstead(squashAtomCommandFailure(result));
  } catch (cause) {
    openedSourceInstead(cause);
  }
}
