import {
  exportEnvironmentWordFile,
  exportEnvironmentWordLatex,
  getEnvironmentWordExportTool,
  installEnvironmentWordExportTool,
} from "@t3tools/client-runtime/state/scient-word-export";
import type {
  EnvironmentId,
  ScientWordFileExportRequest,
  ScientWordLatexExportRequest,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("This environment is not connected.");
  return connection;
}

// Async so a disconnected environment rejects the promise instead of throwing
// synchronously past the caller's rejection handler.
export async function readPandocTool(environmentId: EnvironmentId) {
  return runtime.runPromise(getEnvironmentWordExportTool({ prepared: prepared(environmentId) }));
}

export async function installPandocTool(environmentId: EnvironmentId) {
  return runtime.runPromise(
    installEnvironmentWordExportTool({ prepared: prepared(environmentId) }),
  );
}

export async function exportWordFile(
  environmentId: EnvironmentId,
  request: ScientWordFileExportRequest,
) {
  return runtime.runPromise(
    exportEnvironmentWordFile({ prepared: prepared(environmentId), request }),
  );
}

export async function exportWordLatex(
  environmentId: EnvironmentId,
  request: ScientWordLatexExportRequest,
) {
  return runtime.runPromise(
    exportEnvironmentWordLatex({ prepared: prepared(environmentId), request }),
  );
}
