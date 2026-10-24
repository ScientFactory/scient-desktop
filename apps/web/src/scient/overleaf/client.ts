import {
  cancelEnvironmentOverleafSync,
  connectEnvironmentOverleaf,
  disconnectEnvironmentOverleaf,
  getEnvironmentOverleafStatus,
  getEnvironmentOverleafTokenStatus,
  listEnvironmentOverleafConnections,
  listEnvironmentOverleafKeptCopies,
  previewEnvironmentOverleaf,
  removeEnvironmentOverleafToken,
  restoreEnvironmentOverleafKeptCopy,
  saveEnvironmentOverleafToken,
  syncEnvironmentOverleaf,
} from "@t3tools/client-runtime/state/scient-overleaf";
import type {
  EnvironmentId,
  ScientOverleafConnectionRequest,
  ScientOverleafConnectRequest,
  ScientOverleafDisconnectRequest,
  ScientOverleafPreviewRequest,
  ScientOverleafRestoreRequest,
  ScientOverleafSyncRequest,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { randomUUID } from "../../lib/utils";
import { readPreparedConnection } from "../../state/session";

/**
 * The web side of Overleaf sync: one promise per server operation. Tests mock
 * this module; everything above it is plain React.
 */

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("This environment is not connected.");
  return connection;
}

/** A fresh request ID: the server answers a repeated one with its first result. */
export function overleafRequestId(): string {
  return randomUUID().toLowerCase();
}

// Async so a disconnected environment rejects the promise instead of throwing
// synchronously past the caller's rejection handler.
export async function readOverleafToken(environmentId: EnvironmentId) {
  return runtime.runPromise(
    getEnvironmentOverleafTokenStatus({ prepared: prepared(environmentId) }),
  );
}

export async function saveOverleafToken(environmentId: EnvironmentId, token: string) {
  return runtime.runPromise(
    saveEnvironmentOverleafToken({ prepared: prepared(environmentId), token }),
  );
}

export async function removeOverleafToken(environmentId: EnvironmentId) {
  return runtime.runPromise(removeEnvironmentOverleafToken({ prepared: prepared(environmentId) }));
}

export async function listOverleafConnections(environmentId: EnvironmentId, workspaceRoot: string) {
  return runtime.runPromise(
    listEnvironmentOverleafConnections({
      prepared: prepared(environmentId),
      request: { workspaceRoot },
    }),
  );
}

export async function connectOverleaf(
  environmentId: EnvironmentId,
  request: ScientOverleafConnectRequest,
) {
  return runtime.runPromise(
    connectEnvironmentOverleaf({ prepared: prepared(environmentId), request }),
  );
}

export async function readOverleafStatus(
  environmentId: EnvironmentId,
  request: ScientOverleafConnectionRequest,
) {
  return runtime.runPromise(
    getEnvironmentOverleafStatus({ prepared: prepared(environmentId), request }),
  );
}

export async function previewOverleaf(
  environmentId: EnvironmentId,
  request: ScientOverleafPreviewRequest,
) {
  return runtime.runPromise(
    previewEnvironmentOverleaf({ prepared: prepared(environmentId), request }),
  );
}

export async function syncOverleaf(
  environmentId: EnvironmentId,
  request: ScientOverleafSyncRequest,
) {
  return runtime.runPromise(
    syncEnvironmentOverleaf({ prepared: prepared(environmentId), request }),
  );
}

export async function listOverleafKeptCopies(
  environmentId: EnvironmentId,
  request: ScientOverleafConnectionRequest,
) {
  return runtime.runPromise(
    listEnvironmentOverleafKeptCopies({ prepared: prepared(environmentId), request }),
  );
}

export async function restoreOverleafKeptCopy(
  environmentId: EnvironmentId,
  request: ScientOverleafRestoreRequest,
) {
  return runtime.runPromise(
    restoreEnvironmentOverleafKeptCopy({ prepared: prepared(environmentId), request }),
  );
}

export async function disconnectOverleaf(
  environmentId: EnvironmentId,
  request: ScientOverleafDisconnectRequest,
) {
  return runtime.runPromise(
    disconnectEnvironmentOverleaf({ prepared: prepared(environmentId), request }),
  );
}

/** Asks a running sync to stop at its next stage boundary; never inside an apply or a send. */
export async function cancelOverleafSync(
  environmentId: EnvironmentId,
  request: ScientOverleafConnectionRequest,
) {
  return runtime.runPromise(
    cancelEnvironmentOverleafSync({ prepared: prepared(environmentId), request }),
  );
}
