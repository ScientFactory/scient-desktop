import {
  PROJECT_FILE_NAMES,
  type EnvironmentId,
  type ProjectFileName,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

// SCIENT-FORK:START — scient.json first; t3.json only when the project has no scient.json.
/** A read of one project file name: missing lets the next name answer. */
function toT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  name: ProjectFileName,
  result: ProjectReadFileResult | null,
): T3ProjectFile | null | "missing" {
  const data = resolveProjectFileQueryData(environmentId, workspaceRoot, name, result);
  if (data !== null && data.exists === false) return "missing";
  if (data === null || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}

export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  for (const name of PROJECT_FILE_NAMES) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, name),
      { reportDefect: false, reportFailure: false },
    );
    const file = toT3ProjectFile(
      environmentId,
      workspaceRoot,
      name,
      result._tag === "Success" ? result.value : null,
    );
    if (file !== "missing") return file;
  }
  return null;
}

/** The project's scient.json or t3.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): T3ProjectFile | null | undefined {
  for (const name of PROJECT_FILE_NAMES) {
    const result = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, workspaceRoot, name));
    // A refresh in flight may find a file the cached answer missed, so the answer is not settled.
    if (!AsyncResult.isSuccess(result) || result.waiting) return undefined;
    const file = toT3ProjectFile(environmentId, workspaceRoot, name, result.value);
    if (file !== "missing") return file;
  }
  return null;
}
// SCIENT-FORK:END
