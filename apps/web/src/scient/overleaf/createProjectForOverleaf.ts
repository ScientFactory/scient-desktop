// SCIENT-OWNED: Add project ▸ Overleaf project makes its Scient project the
// way Add project does: the same registration, then Scient's own setup, before
// the paper is linked into a subfolder.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { waitForProjectProjection } from "~/lib/projectProjection";
import {
  initializeScientProjectForOpening,
  inspectScientProjectForOpening,
} from "~/lib/scientProjectInitialization";
import { newProjectId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";

export interface ProjectForOverleaf {
  readonly projectRef: ScopedProjectRef;
  /** The project's workspace root, as the server resolved it. */
  readonly cwd: string;
  /** False when the folder already was a project; it is used as it is. */
  readonly created: boolean;
  /** Whether the project has reached this window's sidebar, so a thread can open in it. */
  readonly ready: boolean;
}

function message(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * Makes the Scient project at `root`, creating the folder when it is missing.
 * A folder that already is a project is used as it is. Throws with a message
 * for the person when nothing was made.
 */
export async function createProjectForOverleaf(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
}): Promise<ProjectForOverleaf> {
  const { environmentId } = input;
  const prepared = readPreparedConnection(environmentId);
  if (prepared === null) throw new Error("This environment is not connected.");
  // The server resolves `~` and symbolic links; its answer is the root from here on.
  const inspection = await inspectScientProjectForOpening(prepared, input.root);
  const cwd = inspection.root;

  const existing = findProjectByPath(
    readProjects().filter((project) => project.environmentId === environmentId),
    cwd,
  );
  if (existing) {
    return {
      projectRef: scopeProjectRef(environmentId, existing.id),
      cwd: existing.workspaceRoot,
      created: false,
      ready: true,
    };
  }

  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot add projects.");
  }
  const projectId = newProjectId();
  const title = inferProjectTitleFromPath(cwd);
  const created = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.create,
    {
      environmentId,
      input: {
        projectId,
        title,
        workspaceRoot: cwd,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    },
    { label: "Add Overleaf project", reportFailure: false },
  );
  if (created._tag === "Failure") throw new Error(message(squashAtomCommandFailure(created)));

  // Scient's own files (AGENTS.md, PROJECT.md, .scient/) sit at the project's
  // top, outside the paper's folder; setup finishes before the link is made.
  // A folder Scient can't set up safely stays without it, as Add project leaves it.
  if (inspection.state === "ordinary" && inspection.canInitialize) {
    await initializeScientProjectForOpening({ prepared, root: cwd, title }).catch(
      (error: unknown) => {
        toastManager.add({
          type: "warning",
          title: "Project made without Scient setup",
          description: message(error),
        });
      },
    );
  }

  const projectRef = scopeProjectRef(environmentId, projectId);
  const ready = await waitForProjectProjection(projectRef);
  return { projectRef, cwd, created: true, ready };
}
