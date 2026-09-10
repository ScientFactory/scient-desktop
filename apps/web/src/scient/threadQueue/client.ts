import {
  enqueueEnvironmentScientThreadQueueItem,
  controlEnvironmentScientThreadQueue,
  listEnvironmentScientThreadQueue,
  removeEnvironmentScientThreadQueueItem,
  reorderEnvironmentScientThreadQueue,
  updateEnvironmentScientThreadQueueItem,
} from "@t3tools/client-runtime/state/scient-thread-queue";
import type {
  EnvironmentId,
  ScientThreadQueueControlRequest,
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueUpdateRequest,
  ScientThreadQueueItemId,
  ThreadId,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function listThreadQueue(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  knownRevision?: number,
) {
  return runtime.runPromise(
    listEnvironmentScientThreadQueue({
      prepared: prepared(environmentId),
      threadId,
      ...(knownRevision !== undefined ? { knownRevision } : {}),
    }),
  );
}

export function enqueueThreadQueueItem(
  environmentId: EnvironmentId,
  input: ScientThreadQueueEnqueueRequest,
) {
  return runtime.runPromise(
    enqueueEnvironmentScientThreadQueueItem({ prepared: prepared(environmentId), ...input }),
  );
}

export function removeThreadQueueItem(
  environmentId: EnvironmentId,
  input: { readonly threadId: ThreadId; readonly queueItemId: ScientThreadQueueItemId },
) {
  return runtime.runPromise(
    removeEnvironmentScientThreadQueueItem({ prepared: prepared(environmentId), ...input }),
  );
}

export function updateThreadQueueItem(
  environmentId: EnvironmentId,
  input: ScientThreadQueueUpdateRequest,
) {
  return runtime.runPromise(
    updateEnvironmentScientThreadQueueItem({ prepared: prepared(environmentId), ...input }),
  );
}

export function reorderThreadQueue(
  environmentId: EnvironmentId,
  input: {
    readonly threadId: ThreadId;
    readonly queueItemIds: ReadonlyArray<ScientThreadQueueItemId>;
  },
) {
  return runtime.runPromise(
    reorderEnvironmentScientThreadQueue({ prepared: prepared(environmentId), ...input }),
  );
}

export function controlThreadQueue(
  environmentId: EnvironmentId,
  payload: ScientThreadQueueControlRequest,
) {
  return runtime.runPromise(
    controlEnvironmentScientThreadQueue({ prepared: prepared(environmentId), payload }),
  );
}
