import { listEnvironmentScientThreadQueue } from "@t3tools/client-runtime/state/scient-thread-queue";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

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
