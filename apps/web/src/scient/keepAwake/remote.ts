import {
  KEEP_AWAKE_REMOTE_OBSERVER,
  EnvironmentId,
  type ThreadId,
  type KeepAwakeWorkBatch,
} from "@t3tools/contracts";
import { observeEnvironmentKeepAwake } from "@t3tools/client-runtime/state/scient-keep-awake";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";

declare global {
  interface Window {
    __scientObserveKeepAwake?: (
      environmentId: string,
      threadIds: readonly ThreadId[],
    ) => Promise<KeepAwakeWorkBatch>;
  }
}

export function registerRemoteKeepAwakeObserver() {
  const observe = async (environmentId: string, threadIds: readonly ThreadId[]) => {
    const prepared = readPreparedConnection(EnvironmentId.make(environmentId));
    if (prepared === null)
      return Promise.reject(new Error("The remote environment is not connected."));
    const result = await executeAtomQuery(
      appAtomRegistry,
      connectionAtomRuntime.atom(observeEnvironmentKeepAwake({ prepared, threadIds })),
      { label: "Observe remote keep-awake work", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  window[KEEP_AWAKE_REMOTE_OBSERVER] = observe;
  return () => {
    if (window[KEEP_AWAKE_REMOTE_OBSERVER] === observe) delete window[KEEP_AWAKE_REMOTE_OBSERVER];
  };
}
