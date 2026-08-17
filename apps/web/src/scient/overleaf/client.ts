import {
  cancelEnvironmentScientOverleafOperation,
  completeEnvironmentScientOverleafPreflight,
  confirmEnvironmentScientOverleafReview,
  continueEnvironmentScientOverleafOperation,
  disconnectEnvironmentScientOverleafConnection,
  getEnvironmentScientOverleafConflict,
  getEnvironmentScientOverleafOperation,
  getEnvironmentScientOverleafOverview,
  listEnvironmentScientOverleafConflicts,
  reconcileEnvironmentScientOverleafLocal,
  removeEnvironmentScientOverleafAccount,
  repairEnvironmentScientOverleafConnection,
  resolveEnvironmentScientOverleafConflict,
  retryEnvironmentScientOverleafOperation,
  saveEnvironmentScientOverleafAccount,
  startEnvironmentScientOverleafPreflight,
  startEnvironmentScientOverleafSync,
  updateEnvironmentScientOverleafConnection,
} from "@t3tools/client-runtime/state/scient-overleaf";
import type {
  EnvironmentId,
  ScientOverleafConflictResolutionRequest,
  ScientOverleafConnectionSettingsRequest,
  ScientOverleafDisconnectRequest,
  ScientOverleafPreflightCompleteRequest,
  ScientOverleafPreflightStartRequest,
  ScientOverleafReviewConfirmationRequest,
  ScientOverleafSaveAccountRequest,
  ScientOverleafSyncStartRequest,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export const overleafClient = {
  overview: (environmentId: EnvironmentId, workspaceRoot: string) =>
    runtime.runPromise(
      getEnvironmentScientOverleafOverview({ prepared: prepared(environmentId), workspaceRoot }),
    ),
  saveAccount: (environmentId: EnvironmentId, payload: ScientOverleafSaveAccountRequest) =>
    runtime.runPromise(
      saveEnvironmentScientOverleafAccount({ prepared: prepared(environmentId), payload }),
    ),
  removeAccount: (environmentId: EnvironmentId, accountId: string) =>
    runtime.runPromise(
      removeEnvironmentScientOverleafAccount({ prepared: prepared(environmentId), accountId }),
    ),
  startPreflight: (environmentId: EnvironmentId, payload: ScientOverleafPreflightStartRequest) =>
    runtime.runPromise(
      startEnvironmentScientOverleafPreflight({ prepared: prepared(environmentId), payload }),
    ),
  operation: (environmentId: EnvironmentId, operationId: string) =>
    runtime.runPromise(
      getEnvironmentScientOverleafOperation({ prepared: prepared(environmentId), operationId }),
    ),
  completePreflight: (
    environmentId: EnvironmentId,
    payload: ScientOverleafPreflightCompleteRequest,
  ) =>
    runtime.runPromise(
      completeEnvironmentScientOverleafPreflight({ prepared: prepared(environmentId), payload }),
    ),
  cancel: (environmentId: EnvironmentId, operationId: string) =>
    runtime.runPromise(
      cancelEnvironmentScientOverleafOperation({ prepared: prepared(environmentId), operationId }),
    ),
  updateConnection: (
    environmentId: EnvironmentId,
    payload: ScientOverleafConnectionSettingsRequest,
  ) =>
    runtime.runPromise(
      updateEnvironmentScientOverleafConnection({ prepared: prepared(environmentId), payload }),
    ),
  startSync: (environmentId: EnvironmentId, payload: ScientOverleafSyncStartRequest) =>
    runtime.runPromise(
      startEnvironmentScientOverleafSync({ prepared: prepared(environmentId), payload }),
    ),
  retry: (environmentId: EnvironmentId, operationId: string) =>
    runtime.runPromise(
      retryEnvironmentScientOverleafOperation({ prepared: prepared(environmentId), operationId }),
    ),
  confirmReview: (environmentId: EnvironmentId, payload: ScientOverleafReviewConfirmationRequest) =>
    runtime.runPromise(
      confirmEnvironmentScientOverleafReview({ prepared: prepared(environmentId), payload }),
    ),
  listConflicts: (environmentId: EnvironmentId, operationId: string) =>
    runtime.runPromise(
      listEnvironmentScientOverleafConflicts({ prepared: prepared(environmentId), operationId }),
    ),
  conflict: (environmentId: EnvironmentId, operationId: string, conflictId: string) =>
    runtime.runPromise(
      getEnvironmentScientOverleafConflict({
        prepared: prepared(environmentId),
        operationId,
        conflictId,
      }),
    ),
  resolveConflict: (
    environmentId: EnvironmentId,
    payload: ScientOverleafConflictResolutionRequest,
  ) =>
    runtime.runPromise(
      resolveEnvironmentScientOverleafConflict({ prepared: prepared(environmentId), payload }),
    ),
  continueOperation: (environmentId: EnvironmentId, operationId: string, commitMessage?: string) =>
    runtime.runPromise(
      continueEnvironmentScientOverleafOperation({
        prepared: prepared(environmentId),
        payload: { operationId, ...(commitMessage === undefined ? {} : { commitMessage }) },
      }),
    ),
  reconcileLocal: (environmentId: EnvironmentId, connectionId: string) =>
    runtime.runPromise(
      reconcileEnvironmentScientOverleafLocal({
        prepared: prepared(environmentId),
        connectionId,
      }),
    ),
  repair: (environmentId: EnvironmentId, connectionId: string) =>
    runtime.runPromise(
      repairEnvironmentScientOverleafConnection({
        prepared: prepared(environmentId),
        connectionId,
      }),
    ),
  disconnect: (environmentId: EnvironmentId, payload: ScientOverleafDisconnectRequest) =>
    runtime.runPromise(
      disconnectEnvironmentScientOverleafConnection({ prepared: prepared(environmentId), payload }),
    ),
};
