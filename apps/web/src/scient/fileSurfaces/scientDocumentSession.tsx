import type { EnvironmentId } from "@t3tools/contracts";

import {
  clearProjectFileQueryData,
  projectReadFailure,
  refreshProjectEntriesQuery,
} from "~/components/files/projectFilesQueryState";
import { Button } from "~/components/ui/button";
import { templateEdits } from "~/scient/documents/newDocuments";
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import type { useMarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceLease";

import { refreshFailureNoticeCopy } from "./fileFailureCopy";
import { type FilePostRender, StaticTextFileSurface } from "./StaticTextFileSurface";
import type { useWorkspaceFileRefresh } from "./useWorkspaceFileRefresh";

/**
 * The file the workspace viewer shows when a document session (rich Markdown
 * or LaTeX) owns it, with the session's last refresh failure.
 */
export function scientDocumentSessionFile(
  queriedFile: ReturnType<typeof useWorkspaceFileRefresh>["file"],
  markdownSnapshot: ReturnType<typeof useMarkdownPersistenceLease>["snapshot"],
  relativePath: string | null,
  hostOs: string | null,
) {
  // The editor keeps showing its last confirmed version when a refresh read
  // fails; this is why it failed, so the notice can say the file moved.
  const markdownRefreshFailure =
    markdownSnapshot && !markdownSnapshot.pending
      ? projectReadFailure(markdownSnapshot.error)
      : null;
  const markdownRefreshCopy = refreshFailureNoticeCopy(markdownRefreshFailure, hostOs);
  // Once admitted, the retained draft is the editor's display truth even when
  // an unrelated cached query fails or temporarily returns an older snapshot.
  const file =
    markdownSnapshot && relativePath !== null
      ? {
          ...queriedFile,
          error: null,
          failure: null,
          failureReason: null,
          failureOsErrorCode: null,
          isPending: false,
          data: {
            relativePath,
            contents: markdownSnapshot.draftSource,
            revision: markdownSnapshot.baselineRevision,
            byteLength: queriedFile.data?.byteLength ?? 0,
            truncated: false,
            readOnly: false,
          },
        }
      : queriedFile;
  return { markdownRefreshFailure, markdownRefreshCopy, file };
}

/** Moves the existing file tab to its new path, then reads the new path from disk. */
export function applyScientFileRename(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly usesDocumentSession: boolean;
  readonly destinationRelativePath: string;
  readonly onFileRenamed: (fromPath: string, toPath: string) => void;
}) {
  const { environmentId, cwd, relativePath, destinationRelativePath } = input;
  if (input.usesDocumentSession) {
    markdownPersistenceRegistry.forgetClean({ environmentId, cwd, relativePath });
  }
  templateEdits.move(
    { environmentId, cwd, relativePath },
    { environmentId, cwd, relativePath: destinationRelativePath },
  );
  clearProjectFileQueryData(environmentId, cwd, relativePath);
  refreshProjectEntriesQuery(environmentId, cwd);
  input.onFileRenamed(relativePath, destinationRelativePath);
}

/**
 * Shown when a document session could not be admitted: the reason, a retry,
 * and the last available contents read-only.
 */
export function ScientDocumentSessionAdmissionFailure(props: {
  readonly admissionError: unknown;
  readonly onRetry: () => void;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly contents: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly onPostRender: FilePostRender;
}) {
  return (
    <>
      <div
        role="alert"
        className="shrink-0 border-b border-warning/24 bg-warning-surface px-3 py-2 scient-reading-ui text-xs text-warning-foreground"
      >
        <p>
          This file could not be opened safely for editing. The last available preview is read-only.
        </p>
        <p>
          {props.admissionError instanceof Error
            ? props.admissionError.message
            : "The current disk version could not be verified."}
        </p>
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
      {props.relativePath && props.contents !== undefined ? (
        <StaticTextFileSurface
          cwd={props.cwd}
          relativePath={props.relativePath}
          contents={props.contents}
          resolvedTheme={props.resolvedTheme}
          wordWrap={props.wordWrap}
          onPostRender={props.onPostRender}
        />
      ) : null}
    </>
  );
}
