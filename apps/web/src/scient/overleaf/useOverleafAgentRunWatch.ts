// SCIENT-OWNED: an agent can sync, undo or restore through its Overleaf tools while the
// review tab or a file's chip is on screen. The server has no push for that, so the run
// settling is the signal: every settled run of a thread working in this folder reads the
// links' status again, which drops a review another sync made outdated.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useProjects, useQuietThreadShells } from "~/state/entities";

import { noteOverleafAgentRuns } from "./overleafStore";

const SETTLED = new Set([
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export function useOverleafAgentRunWatch(environmentId: EnvironmentId, workspaceRoot: string) {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const roots = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.workspaceRoot]),
  );
  const runs = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        (thread.worktreePath ?? roots.get(thread.projectId)) === workspaceRoot &&
        thread.latestRun !== null &&
        SETTLED.has(thread.latestRun.status),
    )
    .map((thread) => `${thread.id}:${thread.latestRun?.runId}:${thread.latestRun?.status}`)
    .toSorted()
    .join("\u0000");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- An agent's settled run is outside React: it tells the store to read the server's Overleaf status again.
  useEffect(() => {
    noteOverleafAgentRuns(environmentId, workspaceRoot, runs);
  }, [environmentId, workspaceRoot, runs]);
}
