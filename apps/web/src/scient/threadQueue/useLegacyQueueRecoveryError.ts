import {
  ScientThreadQueueOperationError,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { usePreparedConnection } from "../../state/session";
import { listThreadQueue } from "./client";

const isQueueOperationError = Schema.is(ScientThreadQueueOperationError);

/**
 * Work saved in the pre-native queue that failed to move into the native queue is retained for
 * recovery, and only the old queue's list reports it. Ask once per thread and connection.
 */
export function useLegacyQueueRecoveryError(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): string | null {
  const key = JSON.stringify([environmentId, threadId]);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const [state, setState] = useState<{ key: string; error: string | null }>({
    key,
    error: null,
  });
  useEffect(() => {
    if (!connected || environmentId === null || threadId === null) return;
    let current = true;
    listThreadQueue(environmentId, threadId).then(
      () => {
        if (current) setState({ key, error: null });
      },
      (cause: unknown) => {
        if (current && isQueueOperationError(cause)) setState({ key, error: cause.message });
      },
    );
    return () => {
      current = false;
    };
  }, [connected, environmentId, threadId, key]);
  return state.key === key ? state.error : null;
}
