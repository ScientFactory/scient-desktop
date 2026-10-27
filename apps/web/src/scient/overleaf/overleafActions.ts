// SCIENT-OWNED: Sync with Overleaf, as the chip, the command palette and the
// review tab run it: sync, then report. The server saves the folder's open
// editors in every window first, this one included (EditorFlushHosts answers).
import type {
  EnvironmentId,
  ScientOverleafConflictChoice,
  ScientOverleafSyncResult,
  ScientOverleafUndoResult,
} from "@t3tools/contracts";

import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";

import {
  cancelOverleafSync,
  overleafRequestId,
  previewOverleaf,
  syncOverleaf,
  undoOverleafSend,
} from "./client";
import {
  fileDecisionsRequest,
  operationErrorText,
  overleafProjectUrl,
  overleafResultView,
  refusalText,
  settledText,
  workspacePathOf,
} from "./overleafModel";
import {
  pendingOverleafDecisions,
  reloadOverleafWorkspaces,
  readOverleafWorkspace,
  beginOverleafPreview,
  finishOverleafPreview,
  recordOverleafSync,
  setOverleafSyncing,
  type OverleafConnection,
} from "./overleafStore";

export interface OverleafSyncContext {
  readonly environmentId: EnvironmentId;
  /** The caller's workspace: the main checkout, or a worktree of the same project. */
  readonly workspaceRoot: string;
  readonly connection: OverleafConnection;
  /** Opens the review tab; absent where there is no right panel. */
  readonly openReview?: (() => void) | undefined;
  /** The caller shows the result itself (the Connect dialog); no toast. */
  readonly quiet?: boolean;
}

/** Opens the project's own page on Overleaf. */
export function openOverleafProject(projectId: string): void {
  const url = overleafProjectUrl(projectId);
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url).catch(() => undefined);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * One sync. Clicking Sync is the confirmation: everything but a conflict is
 * done, then reported. A conflict opens the review tab.
 */
export async function runOverleafSync(
  context: OverleafSyncContext,
  decision?: {
    readonly choices?: ReadonlyArray<{
      readonly key: string;
      readonly choice: ScientOverleafConflictChoice;
    }>;
    /**
     * The `remoteTree` of the review whose conflicts the choices answer. If
     * Overleaf has moved since, the server shows the conflicts again instead.
     */
    readonly reviewedRemote?: string;
  },
): Promise<ScientOverleafSyncResult | null> {
  const { environmentId, workspaceRoot, connection } = context;
  if (readOverleafWorkspace(environmentId, workspaceRoot).syncing.has(connection.connectionId)) {
    return null;
  }
  setOverleafSyncing(environmentId, connection.connectionId, true);
  try {
    const { carried, files } = pendingFilesRequest(environmentId, workspaceRoot, connection);
    const result = await syncOverleaf(environmentId, {
      workspaceRoot,
      connectionId: connection.connectionId,
      requestId: overleafRequestId(),
      ...(decision?.choices && decision.choices.length > 0
        ? {
            choices: [...decision.choices],
            ...(decision.reviewedRemote ? { reviewedRemote: decision.reviewedRemote } : {}),
          }
        : {}),
      ...files,
    });
    recordOverleafSync(environmentId, connection.connectionId, result, carried);
    if (!context.quiet) reportOverleafSync(context, result);
    return result;
  } catch (error) {
    if (context.quiet) throw error;
    toastManager.add({
      type: "error",
      title: "Couldn't sync with Overleaf",
      description: operationErrorText(error),
    });
    return null;
  } finally {
    setOverleafSyncing(environmentId, connection.connectionId, false);
    // Files came in: the tree and the chip read again.
    refreshProjectFiles(environmentId, workspaceRoot);
    void reloadOverleafWorkspaces(environmentId, workspaceRoot);
  }
}

/**
 * Every sync, from any entry point (Undo's follow-up sync included), carries the
 * link's pending per-file decisions, reconciled with the review shown; they are
 * cleared only when a sync applies.
 */
function pendingFilesRequest(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connection: Pick<OverleafConnection, "connectionId">,
) {
  const carried = pendingOverleafDecisions(
    readOverleafWorkspace(environmentId, workspaceRoot),
    connection.connectionId,
  );
  const files = fileDecisionsRequest(carried);
  return {
    carried,
    files:
      files.keepOnlyHere.length > 0 || files.send.length > 0 || files.release.length > 0
        ? {
            files: {
              ...(files.keepOnlyHere.length > 0 ? { keepOnlyHere: [...files.keepOnlyHere] } : {}),
              ...(files.send.length > 0 ? { send: [...files.send] } : {}),
              ...(files.release.length > 0 ? { release: [...files.release] } : {}),
            },
          }
        : {},
  };
}

/**
 * Undoes one accepted send (design section 4.3): the server saves the folder's
 * editors, puts back what Overleaf had before it, then syncs with the link's
 * pending per-file decisions, like any sync. The sync's result is recorded like
 * any other; a conflict opens the review tab.
 */
export async function runOverleafUndo(
  context: Pick<
    OverleafSyncContext,
    "environmentId" | "workspaceRoot" | "connection" | "openReview"
  >,
  attemptNumber: number,
): Promise<ScientOverleafUndoResult> {
  const { environmentId, workspaceRoot, connection } = context;
  setOverleafSyncing(environmentId, connection.connectionId, true);
  try {
    const { carried, files } = pendingFilesRequest(environmentId, workspaceRoot, connection);
    const result = await undoOverleafSend(environmentId, {
      workspaceRoot,
      connectionId: connection.connectionId,
      requestId: overleafRequestId(),
      attemptNumber,
      ...files,
    });
    // An undo that stopped partway was not synced: there is no sync to record.
    if (result._tag === "undone" && result.sync._tag !== "not-synced") {
      recordOverleafSync(environmentId, connection.connectionId, result.sync, carried);
      if (result.sync._tag === "needs-decision") context.openReview?.();
    }
    return result;
  } finally {
    setOverleafSyncing(environmentId, connection.connectionId, false);
    refreshProjectFiles(environmentId, workspaceRoot);
    void reloadOverleafWorkspaces(environmentId, workspaceRoot);
  }
}

/** The short message after a sync, with "See changes" when there is something to see. */
export function reportOverleafSync(
  context: Pick<OverleafSyncContext, "openReview" | "connection">,
  result: ScientOverleafSyncResult,
): void {
  const view = overleafResultView(result);
  if (view.needsDecision && context.openReview) context.openReview();
  const openReview = context.openReview;
  const id = toastManager.add({
    type: view.tone,
    title: view.title,
    ...(view.lines.length > 0 ? { description: view.lines.join(" ") } : {}),
    ...(view.hasChanges && !view.needsDecision && openReview
      ? {
          actionProps: {
            children: "See changes",
            onClick: () => {
              toastManager.close(id);
              openReview();
            },
          },
        }
      : {}),
  });
}

/** The workspace path of each conflict's first file, for the editor and the agent. */
export function conflictWorkspacePaths(
  connection: Pick<OverleafConnection, "folder">,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return paths.map((path) => workspacePathOf(connection.folder, path));
}

/**
 * Reads what a sync would bring in and send, without changing Overleaf, for
 * the review tab when no sync in this window has shown it yet.
 */
export async function readOverleafChanges(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
): Promise<void> {
  const current = readOverleafWorkspace(environmentId, workspaceRoot);
  if (current.previewing.has(connectionId) || current.syncing.has(connectionId)) return;
  const startedAt = beginOverleafPreview(environmentId, connectionId);
  try {
    const result = await previewOverleaf(environmentId, { workspaceRoot, connectionId });
    // Reading may first finish an interrupted sync, which writes the folder: always said.
    const settled =
      result._tag !== "recovered" && result.settled ? settledText(result.settled) : null;
    finishOverleafPreview(
      environmentId,
      connectionId,
      startedAt,
      result._tag === "review"
        ? { _tag: "review", review: result.review, note: settled }
        : {
            _tag: "failed",
            message:
              result._tag === "refused"
                ? [settled, refusalText(result.refusal)].filter(Boolean).join(" ")
                : "An interrupted sync was finished first. Read the changes again.",
          },
    );
  } catch (error) {
    finishOverleafPreview(environmentId, connectionId, startedAt, {
      _tag: "failed",
      message: operationErrorText(error),
    });
  } finally {
    // The read held the link: a status read meanwhile said it was busy.
    void reloadOverleafWorkspaces(environmentId, workspaceRoot);
  }
}

/**
 * Asks the link's running sync to stop. It stops at the next stage boundary,
 * never inside an apply or a send; the sync's own result then says it stopped.
 */
export async function cancelOverleafRun(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  connectionId: string,
): Promise<void> {
  try {
    const result = await cancelOverleafSync(environmentId, { workspaceRoot, connectionId });
    if (result._tag === "nothing-running") {
      toastManager.add({ type: "info", title: "No sync is running" });
      // A chip still on "Syncing…" read a busy status that has since ended.
      void reloadOverleafWorkspaces(environmentId, workspaceRoot, { afterOwnOperation: false });
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't cancel the sync",
      description: operationErrorText(error),
    });
  }
}
