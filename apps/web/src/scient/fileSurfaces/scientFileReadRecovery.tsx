import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  fileCopyNotice,
  saveEnvironmentFileCopy,
} from "~/scient/fileOpening/saveEnvironmentFileCopy";
import { assetEnvironment } from "~/state/assets";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { isOutsideProjectFailure, readFailureBlocksPreview } from "./fileFailureCopy";
import { FileReadFailure } from "./FileReadFailure";
import type { scientDocumentSessionFile } from "./scientDocumentSession";
import { useMissingFileChoices } from "./useMissingFileChoices";

/**
 * How the files panel answers a read it cannot show: the files a missing path
 * may have meant, the read failure shown instead of a preview, and a copy of
 * the file saved to this device.
 */
export function useScientFileReadRecovery({
  environmentId,
  cwd,
  relativePath,
  attachment,
  isHostFile,
  isDirectory,
  absolutePath,
  environmentHttpBaseUrl,
  file,
  markdownRefreshFailure,
  hostOs,
  requestManualReload,
  onOpenFile,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string | null;
  attachment: ChatFileAttachment | undefined;
  isHostFile: boolean;
  isDirectory: boolean;
  absolutePath: string | null;
  environmentHttpBaseUrl: string | null;
  file: ReturnType<typeof scientDocumentSessionFile>["file"];
  markdownRefreshFailure: ReturnType<typeof scientDocumentSessionFile>["markdownRefreshFailure"];
  hostOs: string | null;
  requestManualReload: () => void;
  onOpenFile: (relativePath: string) => void;
}) {
  // A copy must be of the file as it is now. An exact capability is pinned to
  // the revision it was issued for, so a cached one would refuse a changed file.
  const createCopyUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const missingFile = useMissingFileChoices({
    environmentId,
    cwd,
    path: attachment === undefined ? relativePath : null,
    // Asked whenever the path is missing, including under a last good copy of
    // a file that was renamed or moved while it was open.
    failureReason: file.failureReason ?? markdownRefreshFailure?.reason ?? null,
  });
  const readOnlyHostPath = missingFile.absolutePath;
  const readFailureShownInstead = readFailureBlocksPreview({
    hasData: file.data !== null,
    failure: file.failure,
    reason: file.failureReason,
    isHostFile,
  });
  // A copy on the device in hand: the one way to take a file Scient cannot
  // preview to another app when the viewer is not on the machine that holds it.
  const savingCopyRef = useRef(false);
  const handleSaveCopy = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl || savingCopyRef.current) return;
    savingCopyRef.current = true;
    void saveEnvironmentFileCopy({
      environmentId,
      path: absolutePath,
      httpBaseUrl: environmentHttpBaseUrl,
      createAssetUrl: createCopyUrl,
    })
      .then(
        (result) => fileCopyNotice(result),
        // The desktop shell or browser refused before any result existed.
        () => fileCopyNotice({ _tag: "failed", reason: "write-failed" }),
      )
      .then((notice) => {
        if (notice) toastManager.add(stackedThreadToast(notice));
      })
      .finally(() => {
        savingCopyRef.current = false;
      });
  }, [absolutePath, createCopyUrl, environmentHttpBaseUrl, environmentId]);
  const canSaveCopy =
    attachment === undefined && absolutePath !== null && !isDirectory && !!environmentHttpBaseUrl;

  const readFailure = (
    <FileReadFailure
      failure={file.failure}
      reason={file.failureReason}
      osErrorCode={file.failureOsErrorCode}
      hostOs={hostOs}
      message={file.error}
      retrying={file.isPending}
      onRetry={requestManualReload}
      path={missingFile.absolutePath ?? relativePath ?? ""}
      candidates={missingFile.paths}
      candidatesIncomplete={missingFile.incomplete}
      onOpenCandidate={onOpenFile}
      {...(canSaveCopy ? { onSaveCopy: handleSaveCopy } : {})}
    />
  );
  const blockingReadFailure =
    file.data === null && isOutsideProjectFailure(file.failure) ? (
      // Only an older server refuses a path by location; media and document
      // previews would fail to authorize it the same way. Its absolute path
      // still opens read-only.
      <FileReadFailure
        failure={file.failure}
        message={file.error}
        retrying={false}
        onRetry={requestManualReload}
        {...(readOnlyHostPath !== null
          ? { onOpenReadOnly: () => onOpenFile(readOnlyHostPath) }
          : {})}
      />
    ) : readFailureShownInstead ? (
      // The read already says why nothing can be shown (missing, denied,
      // or not a regular file); a media or document viewer would only fail
      // again with less to say.
      readFailure
    ) : null;
  return { missingFile, canSaveCopy, handleSaveCopy, readFailure, blockingReadFailure };
}
