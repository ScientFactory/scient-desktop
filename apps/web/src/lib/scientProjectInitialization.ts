import {
  initializeEnvironmentScientProject,
  inspectEnvironmentScientProject,
} from "@t3tools/client-runtime/state/scient-project";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  ScientProjectInitializationResult,
  ScientProjectInspection,
} from "@t3tools/contracts";

import { runtime } from "./runtime";

export type ScientProjectInitializationDecision = "cancel" | "initialize" | "open-only";

export function inspectScientProjectForOpening(
  prepared: PreparedConnection,
  root: string,
): Promise<ScientProjectInspection> {
  return runtime.runPromise(inspectEnvironmentScientProject({ prepared, root }));
}

export function initializeScientProjectForOpening(input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly title: string;
}): Promise<ScientProjectInitializationResult> {
  return runtime.runPromise(
    initializeEnvironmentScientProject({
      prepared: input.prepared,
      root: input.root,
      title: input.title,
    }),
  );
}

export function scientProjectFolderName(root: string): string {
  return root.split(/[/\\]/u).findLast((segment) => segment.length > 0) ?? root;
}
