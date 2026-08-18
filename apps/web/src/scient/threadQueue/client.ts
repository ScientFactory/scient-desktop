import {
  enqueueEnvironmentScientThreadQueueItem,
  listEnvironmentScientThreadQueue,
  removeEnvironmentScientThreadQueueItem,
  reorderEnvironmentScientThreadQueue,
} from "@t3tools/client-runtime/state/scient-thread-queue";
import type {
  EnvironmentId,
  ScientThreadQueueItemId,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function listThreadQueue(environmentId: EnvironmentId, threadId: ThreadId) {
  return runtime.runPromise(
    listEnvironmentScientThreadQueue({ prepared: prepared(environmentId), threadId }),
  );
}

export function enqueueThreadQueueItem(
  environmentId: EnvironmentId,
  input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly attachments: ReadonlyArray<UploadChatAttachment>;
  },
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
