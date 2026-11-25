import { RegistryContext } from "@effect/atom-react";
import type {
  EnvironmentId,
  NotebookFreshRun,
  NotebookFreshRunInput,
  NotebookFreshRunUpdate,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { useContext, useState } from "react";

import { computeEnvironment } from "~/state/compute";
import { useEnvironmentSubscription } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export function useNotebookFreshRun(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly scriptPath: string;
}) {
  const gt = useGT();
  const submit = useAtomCommand(computeEnvironment.notebookFreshStart, { reportFailure: false });
  const cancel = useAtomCommand(computeEnvironment.notebookFreshStop, { reportFailure: false });
  const { environmentId, cwd, scriptPath } = input;
  const address = { cwd, scriptPath };
  const registry = useContext(RegistryContext);
  const updatesAtom = computeEnvironment.notebookFreshRun({ environmentId, input: address });
  const updates = useEnvironmentSubscription(updatesAtom);
  const scope = JSON.stringify([environmentId, cwd, scriptPath]);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [accepted, setAccepted] = useState<{
    scope: string;
    job: NotebookFreshRun;
    previousSnapshot: NotebookFreshRunUpdate | null;
  } | null>(null);
  const awaitingSnapshot =
    accepted?.scope === scope && accepted.previousSnapshot === updates.data && !updates.error;
  const job = updates.error ? null : awaitingSnapshot ? accepted.job : (updates.data?.job ?? null);

  const start = async (
    settings: Pick<NotebookFreshRunInput, "parameters" | "inputs" | "sweep">,
  ) => {
    setStarting(scope);
    setAccepted(null);
    setError(null);
    const result = await submit({ environmentId, input: { ...address, ...settings } }).catch(
      () => null,
    );
    if (result?._tag === "Success") {
      const snapshot = AsyncResult.getOrElse(registry.get(updatesAtom), () => null);
      if (
        snapshot?.job?.runId !== result.value.runId &&
        snapshot?.settledRunId !== result.value.runId
      ) {
        setAccepted({ scope, job: result.value, previousSnapshot: snapshot });
        // Obtain a snapshot after admission even if this subscription missed the start event.
        updates.refresh();
      }
    } else {
      setError({ scope, message: gt("The notebook could not start.") });
    }
    setStarting((current) => (current === scope ? null : current));
  };
  const stop = async () => {
    if (job === null || job.outcome !== undefined) return;
    const result = await cancel({ environmentId, input: { ...address, runId: job.runId } }).catch(
      () => null,
    );
    if (result?._tag !== "Success")
      setError({ scope, message: gt("The notebook run could not be stopped.") });
  };
  return {
    job,
    settledRunId: updates.data?.settledRunId ?? null,
    running: starting === scope || (job !== null && job.outcome === undefined),
    start,
    stop,
    error: error?.scope === scope ? error.message : updates.error,
  };
}
