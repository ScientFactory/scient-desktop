import {
  getEnvironmentLatexBuild,
  getEnvironmentLatexCancel,
  getEnvironmentLatexInstallToolchain,
  getEnvironmentLatexStatus,
  getEnvironmentLatexToolchain,
} from "@t3tools/client-runtime/state/scient-latex";
import type { EnvironmentId } from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

/** A LaTeX root document addressed the way the file panel addresses files. */
export interface ScientLatexDocumentRef {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function requestLatexBuild(environmentId: EnvironmentId, input: ScientLatexDocumentRef) {
  return runtime.runPromise(
    getEnvironmentLatexBuild({ prepared: prepared(environmentId), ...input }),
  );
}

export function readLatexBuildStatus(environmentId: EnvironmentId, input: ScientLatexDocumentRef) {
  return runtime.runPromise(
    getEnvironmentLatexStatus({ prepared: prepared(environmentId), ...input }),
  );
}

export function requestLatexCancel(environmentId: EnvironmentId, input: ScientLatexDocumentRef) {
  return runtime.runPromise(
    getEnvironmentLatexCancel({ prepared: prepared(environmentId), ...input }),
  );
}

export function readLatexToolchain(
  environmentId: EnvironmentId,
  input: { readonly refresh: boolean },
) {
  return runtime.runPromise(
    getEnvironmentLatexToolchain({ prepared: prepared(environmentId), ...input }),
  );
}

/** Asks the environment to install the LaTeX distribution Scient pins. */
export function requestLatexToolchainInstall(environmentId: EnvironmentId) {
  return runtime.runPromise(
    getEnvironmentLatexInstallToolchain({ prepared: prepared(environmentId) }),
  );
}
