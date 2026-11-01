// SCIENT-OWNED: when this thread works in another copy than the link, open the new thread in
// the linked copy, where the marks and files are: for Ask the agent and for opening a file in
// its normal editor.
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useRightPanelStore } from "~/rightPanelStore";
import { readProjects, readThreadShell } from "~/state/entities";

import type { OverleafConnection } from "./overleafStore";

interface LinkedCopyInput {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly connection: Pick<OverleafConnection, "checkoutRoot">;
  readonly handleNewThread: ReturnType<typeof useNewThreadHandler>;
}

/** Opens a new thread on the linked copy; null when it can't. */
async function startThreadOnLinkedCopy(input: LinkedCopyInput) {
  const { environmentId, connection } = input;
  // The linked copy is a project's own folder, or a worktree of this thread's project.
  const main = readProjects().find(
    (project) =>
      project.environmentId === environmentId && project.workspaceRoot === connection.checkoutRoot,
  );
  const projectId =
    main?.id ?? (input.threadRef ? readThreadShell(input.threadRef)?.projectId : null) ?? null;
  if (projectId === null) return null;
  return input
    .handleNewThread(
      scopeProjectRef(environmentId, projectId),
      main
        ? { worktreePath: null, envMode: "local" }
        : { worktreePath: connection.checkoutRoot, envMode: "worktree" },
    )
    .catch(() => null);
}

export async function askAgentOnLinkedCopy(
  input: LinkedCopyInput & { readonly message: string },
): Promise<boolean> {
  const opened = await startThreadOnLinkedCopy(input);
  if (opened === null) return false;
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(opened.draftId)?.prompt ?? "";
  store.setPrompt(
    opened.draftId,
    existing.length > 0 ? `${existing}\n\n${input.message}` : input.message,
  );
  return true;
}

/**
 * Opens a linked copy's file in its normal editor, where its conflict marks can
 * be settled and saved: in a new thread on that copy, whose files are that
 * copy's. This checkout's file of the same name is never opened.
 */
export async function openFileOnLinkedCopy(
  input: LinkedCopyInput & { readonly relativePath: string },
): Promise<boolean> {
  const opened = await startThreadOnLinkedCopy(input);
  if (opened === null) return false;
  useRightPanelStore
    .getState()
    .openFile(scopeThreadRef(input.environmentId, opened.threadId), input.relativePath);
  return true;
}
