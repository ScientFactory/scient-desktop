import type { EnvironmentId, NotebookFreshRun, NotebookFreshRunInput } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";

export function useNotebookFreshRun(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly scriptPath: string;
}) {
  const gt = useGT();
  const submit = useAtomCommand(computeEnvironment.notebookFreshStart, { reportFailure: false });
  const status = useAtomCommand(computeEnvironment.notebookFreshStatus, { reportFailure: false });
  const cancel = useAtomCommand(computeEnvironment.notebookFreshStop, { reportFailure: false });
  const scope = JSON.stringify([input.environmentId, input.cwd, input.scriptPath]);
  const [observed, setObserved] = useState<{ scope: string; job: NotebookFreshRun | null } | null>(
    null,
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const observe = (observedScope: string, job: NotebookFreshRun | null) => {
    setObserved((previous) =>
      previous?.scope === observedScope && JSON.stringify(previous.job) === JSON.stringify(job)
        ? previous
        : { scope: observedScope, job },
    );
  };
  const readStatus = useStableCallback(async () => {
    const before = sequence.current;
    const result = await status({
      environmentId: input.environmentId,
      input: { cwd: input.cwd, scriptPath: input.scriptPath },
    });
    return before === sequence.current && result._tag === "Success" ? result.value : undefined;
  });
  const observeStatus = useStableCallback(observe);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- recover the server's job after opening a notebook or reconnecting.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const job = await readStatus();
      if (!active) return;
      if (job !== undefined) observeStatus(scope, job);
      timer = setTimeout(() => void poll(), job != null && job.outcome === undefined ? 500 : 2500);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [scope, readStatus, observeStatus]);

  const start = async (
    settings: Pick<NotebookFreshRunInput, "parameters" | "inputs" | "sweep">,
  ) => {
    sequence.current += 1;
    setStarting(true);
    setError(null);
    try {
      const result = await submit({
        environmentId: input.environmentId,
        input: { cwd: input.cwd, scriptPath: input.scriptPath, ...settings },
      });
      if (result._tag === "Success") observe(scope, result.value);
      else setError(gt("The notebook could not start."));
    } catch {
      setError(gt("The notebook could not start."));
    }
    sequence.current += 1;
    setStarting(false);
  };

  const job = observed?.scope === scope ? observed.job : null;
  const stop = async () => {
    if (job === null || job.outcome !== undefined) return;
    sequence.current += 1;
    const result = await cancel({
      environmentId: input.environmentId,
      input: { cwd: input.cwd, scriptPath: input.scriptPath, runId: job.runId },
    });
    sequence.current += 1;
    if (result._tag === "Success") observe(scope, result.value);
    else setError(gt("The notebook run could not be stopped."));
  };
  return {
    job,
    running: starting || (job !== null && job.outcome === undefined),
    start,
    stop,
    error,
  };
}
