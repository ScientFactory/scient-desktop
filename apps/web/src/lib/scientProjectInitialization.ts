import {
  initializeEnvironmentScientProject,
  inspectEnvironmentScientProject,
} from "@t3tools/client-runtime/state/scient-project";
import type {
  EnvironmentId,
  ScientProjectInitializationResult,
  ScientProjectInspection,
} from "@t3tools/contracts";

import { runtime } from "./runtime";
import { readPreparedConnection } from "../state/session";

function preparedConnection(environmentId: EnvironmentId) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("The selected environment is not connected.");
  return prepared;
}

export function inspectScientProjectForOpening(
  environmentId: EnvironmentId,
  root: string,
): Promise<ScientProjectInspection> {
  return runtime.runPromise(
    inspectEnvironmentScientProject({ prepared: preparedConnection(environmentId), root }),
  );
}

export function initializeScientProjectForOpening(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly title: string;
}): Promise<ScientProjectInitializationResult> {
  return runtime.runPromise(
    initializeEnvironmentScientProject({
      prepared: preparedConnection(input.environmentId),
      root: input.root,
      title: input.title,
    }),
  );
}

export function scientProjectFolderName(root: string): string {
  return root.split(/[/\\]/u).findLast((segment) => segment.length > 0) ?? root;
}
