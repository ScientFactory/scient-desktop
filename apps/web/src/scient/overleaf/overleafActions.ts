// SCIENT-OWNED: Sync with Overleaf, as the chip, the command palette and the
// review tab run it: save the folder's open editors, sync, then report.
import type {
  EnvironmentId,
  ScientOverleafConflictChoice,
  ScientOverleafSyncResult,
} from "@t3tools/contracts";

import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";
import { workspaceFileSessionFlush } from "~/components/files/useFileSaveCoordinator";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

import { cancelOverleafSync, overleafRequestId, previewOverleaf, syncOverleaf } from "./client";
import {
  operationErrorText,
  overleafProjectUrl,
  overleafResultView,
  refusalText,
  workspacePathOf,
} from "./overleafModel";
import {
  loadOverleafWorkspace,
  readOverleafWorkspace,
  recordOverleafPreview,
  recordOverleafSync,
  setOverleafSyncing,
  type OverleafConnection,
} from "./overleafStore";

/** Whether an open editor's file is in the linked folder of the linked checkout. */
function inLinkedFolder(
  environmentId: EnvironmentId,
  roots: ReadonlyArray<string>,
  folder: string,
): (target: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}) => boolean {
  const base = folder.replace(/^\/+|\/+$/gu, "");
  return (target) =>
    target.environmentId === environmentId &&
    roots.includes(target.cwd) &&
    (base === "" || target.relativePath === base || target.relativePath.startsWith(`${base}/`));
}

/**
 * Saves every open editor of the folder in this window (design section 6):
 * document sessions (Markdown, LaTeX, BibTeX) and plain text editors. Returns
 * the files that couldn't be saved, such as unconverted Visual input or a
 * save that failed.
 *
 * Plain editors are flushed through `workspaceFileSessionFlush.flushWhere`,
 * the scoped flush PR #643 adds to `WorkspaceFileSessionRegistry` (copied here
 * as #643 has it, so the two merge as one). Once #643's server request saves
 * a folder's editors in every window, this should call that instead.
 */
async function saveOverleafFolderEditors(
  environmentId: EnvironmentId,
  roots: ReadonlyArray<string>,
  folder: string,
): Promise<ReadonlyArray<string>> {
  const select = inLinkedFolder(environmentId, roots, folder);
  const documents = markdownPersistenceRegistry.getSnapshot().filter(select);
  const [saved, plain] = await Promise.all([
    Promise.all(
      documents.map((entry) =>
        markdownPersistenceRegistry.flushTarget(entry).then(
          (done) => done,
          () => false,
        ),
      ),
    ),
    workspaceFileSessionFlush.flushWhere(select).then(
      (outcomes) => outcomes,
      () => null,
    ),
  ]);
  return [
    ...documents.flatMap((entry, index) => (saved[index] ? [] : [entry.relativePath])),
    ...(plain === null
      ? [folder || "An open file"]
      : plain.flatMap((outcome) => (outcome.saved ? [] : [outcome.target.relativePath]))),
  ];
}

/** An open editor of the folder couldn't save, so nothing was synced. */
class OverleafEditorsUnsavedError extends Error {
  readonly reason = "editor-unsaved";
  constructor(readonly path: string) {
    super(refusalText({ reason: "editor-unsaved", path }));
  }
}

/**
 * Syncs started from this window that haven't sent their request yet, by
 * link. Cancel before the request marks one here, and it never sends.
 */
const localRuns = new Map<string, { cancelled: boolean; sent: boolean }>();
const runKey = (environmentId: EnvironmentId, connectionId: string) =>
  `${environmentId}\u0000${connectionId}`;

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
    /** Per-file decisions: new files to keep only here, files to send anyway. */
    readonly files?: {
      readonly keepOnlyHere: ReadonlyArray<string>;
      readonly send: ReadonlyArray<string>;
    };
  },
): Promise<ScientOverleafSyncResult | null> {
  const { environmentId, workspaceRoot, connection } = context;
  if (readOverleafWorkspace(environmentId, workspaceRoot).syncing.has(connection.connectionId)) {
    return null;
  }
  setOverleafSyncing(environmentId, workspaceRoot, connection.connectionId, true);
  const run = { cancelled: false, sent: false };
  const key = runKey(environmentId, connection.connectionId);
  localRuns.set(key, run);
  try {
    const unsaved = await saveOverleafFolderEditors(
      environmentId,
      [workspaceRoot, connection.checkoutRoot],
      connection.folder,
    );
    if (unsaved.length > 0) {
      if (context.quiet) throw new OverleafEditorsUnsavedError(unsaved[0]!);
      toastManager.add({
        type: "error",
        title: "Couldn't sync with Overleaf",
        description: new OverleafEditorsUnsavedError(unsaved[0]!).message,
      });
      return null;
    }
    // Cancelled while editors were saving: the request is never sent.
    if (run.cancelled) {
      const cancelled: ScientOverleafSyncResult = { _tag: "cancelled", stage: "before-prepare" };
      recordOverleafSync(environmentId, workspaceRoot, connection.connectionId, cancelled);
      if (!context.quiet) reportOverleafSync(context, cancelled);
      return cancelled;
    }
    run.sent = true;
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
      ...(decision?.files &&
      (decision.files.keepOnlyHere.length > 0 || decision.files.send.length > 0)
        ? {
            files: {
              ...(decision.files.keepOnlyHere.length > 0
                ? { keepOnlyHere: [...decision.files.keepOnlyHere] }
                : {}),
              ...(decision.files.send.length > 0 ? { send: [...decision.files.send] } : {}),
            },
          }
        : {}),
    });
    recordOverleafSync(environmentId, workspaceRoot, connection.connectionId, result);
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
    if (localRuns.get(key) === run) localRuns.delete(key);
    setOverleafSyncing(environmentId, workspaceRoot, connection.connectionId, false);
    // Files came in: the tree and the chip read again.
    refreshProjectFiles(environmentId, workspaceRoot);
    void loadOverleafWorkspace(environmentId, workspaceRoot, { force: true });
  }
}

/** The short message after a sync, with "See changes" when there is something to see. */
function reportOverleafSync(
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
  if (current.previewing.has(connectionId)) return;
  recordOverleafPreview(environmentId, workspaceRoot, connectionId, { _tag: "reading" });
  try {
    const result = await previewOverleaf(environmentId, { workspaceRoot, connectionId });
    recordOverleafPreview(
      environmentId,
      workspaceRoot,
      connectionId,
      result._tag === "review"
        ? { _tag: "review", review: result.review }
        : {
            _tag: "failed",
            message:
              result._tag === "refused"
                ? refusalText(result.refusal)
                : "An interrupted sync was finished first. Read the changes again.",
          },
    );
  } catch (error) {
    recordOverleafPreview(environmentId, workspaceRoot, connectionId, {
      _tag: "failed",
      message: operationErrorText(error),
    });
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
  // Still saving editors here: stop before the request leaves this window.
  const local = localRuns.get(runKey(environmentId, connectionId));
  if (local && !local.sent) {
    local.cancelled = true;
    return;
  }
  try {
    const result = await cancelOverleafSync(environmentId, { workspaceRoot, connectionId });
    if (result._tag === "nothing-running")
      toastManager.add({ type: "info", title: "No sync is running" });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't cancel the sync",
      description: operationErrorText(error),
    });
  }
}
