// SCIENT-OWNED: Sync with Overleaf, as the chip, the command palette and the
// review tab run it: save the folder's open editors, sync, then report.
import type {
  EnvironmentId,
  ScientOverleafConflictChoice,
  ScientOverleafSyncResult,
} from "@t3tools/contracts";

import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";
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

/** Which open editors belong to a linked folder: same checkout, path inside the folder. */
function editorsInFolder(
  environmentId: EnvironmentId,
  roots: ReadonlyArray<string>,
  folder: string,
) {
  const base = folder.replace(/^\/+|\/+$/gu, "");
  return markdownPersistenceRegistry
    .getSnapshot()
    .filter(
      (entry) =>
        entry.environmentId === environmentId &&
        roots.includes(entry.cwd) &&
        (base === "" || entry.relativePath === base || entry.relativePath.startsWith(`${base}/`)),
    );
}

/**
 * Saves every open editor of the folder in this window (design section 6).
 * Returns the files that couldn't be saved, such as unconverted Visual input.
 */
async function saveOverleafFolderEditors(
  environmentId: EnvironmentId,
  roots: ReadonlyArray<string>,
  folder: string,
): Promise<ReadonlyArray<string>> {
  const entries = editorsInFolder(environmentId, roots, folder);
  const saved = await Promise.all(
    entries.map((entry) =>
      markdownPersistenceRegistry.flushTarget(entry).then(
        (done) => done,
        () => false,
      ),
    ),
  );
  return entries.flatMap((entry, index) => (saved[index] ? [] : [entry.relativePath]));
}

/** An open editor of the folder couldn't save, so nothing was synced. */
class OverleafEditorsUnsavedError extends Error {
  constructor(readonly path: string) {
    super(`${path} couldn't be saved, so nothing was synced. Save it, then sync again.`);
  }
}

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
    readonly choices: ReadonlyArray<{
      readonly key: string;
      readonly choice: ScientOverleafConflictChoice;
    }>;
    /**
     * The `remoteTree` of the review whose conflicts the choices answer. If
     * Overleaf has moved since, the server shows the conflicts again instead.
     */
    readonly reviewedRemote: string;
  },
): Promise<ScientOverleafSyncResult | null> {
  const { environmentId, workspaceRoot, connection } = context;
  if (readOverleafWorkspace(environmentId, workspaceRoot).syncing.has(connection.connectionId)) {
    return null;
  }
  setOverleafSyncing(environmentId, workspaceRoot, connection.connectionId, true);
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
    const result = await syncOverleaf(environmentId, {
      workspaceRoot,
      connectionId: connection.connectionId,
      requestId: overleafRequestId(),
      ...(decision && decision.choices.length > 0
        ? { choices: [...decision.choices], reviewedRemote: decision.reviewedRemote }
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
