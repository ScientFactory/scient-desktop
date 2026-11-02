import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";

/** A new conversation in the scratch project, for what starts outside any conversation. */
export function useScratchThread(environmentId: EnvironmentId) {
  const { openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  return async () => {
    const project = await openScratchProject(environmentId, "Could not open the site");
    if (!project) return null;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    return opened ? scopeThreadRef(project.environmentId, opened.threadId) : null;
  };
}
