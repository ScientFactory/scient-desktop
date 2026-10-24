// SCIENT-OWNED: "Ask the agent" when this thread works in another copy of the
// project than the link. The marks are in the linked copy's files, so a new
// thread opens there, as "New thread on this branch" does, with the message
// ready to send.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { readProjects, readThreadShell } from "~/state/entities";

import type { OverleafConnection } from "./overleafStore";

export async function askAgentOnLinkedCopy(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly connection: Pick<OverleafConnection, "checkoutRoot">;
  readonly message: string;
  readonly handleNewThread: ReturnType<typeof useNewThreadHandler>;
}): Promise<boolean> {
  const { environmentId, connection } = input;
  // The linked copy is a project's own folder, or a worktree of this thread's project.
  const main = readProjects().find(
    (project) =>
      project.environmentId === environmentId && project.workspaceRoot === connection.checkoutRoot,
  );
  const projectId =
    main?.id ?? (input.threadRef ? readThreadShell(input.threadRef)?.projectId : null) ?? null;
  if (projectId === null) return false;
  const opened = await input
    .handleNewThread(
      scopeProjectRef(environmentId, projectId),
      main
        ? { worktreePath: null, envMode: "local" }
        : { worktreePath: connection.checkoutRoot, envMode: "worktree" },
    )
    .catch(() => null);
  if (opened === null) return false;
  useComposerDraftStore.getState().setPrompt(opened.draftId, input.message);
  return true;
}
