import { T, useGT, Var } from "gt-react";
import { useRef, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { ComputeSessionId, type ComputeSessionRecord } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { managedDependencyRuntime } from "./computeDependencyRecovery";
import { replaceComputeContextSession } from "./computeContextCoordinator";
import {
  getComputeContext,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";

/** What an error row can do about a missing dependency, given by the surface that owns the run. */
export interface ComputeDependencyRecoveryPlace {
  readonly contextId: ComputeContextId;
  readonly onSettled: () => void;
  /** Runs the failed code again in the same session: the run's code, or a notebook's cell. */
  readonly runAgain?: (() => void) | undefined;
  /** The same code has since run successfully, so there is nothing left to fix. */
  readonly resolved?: boolean | undefined;
}

/**
 * Adds a reviewed package beside the session's Python, never into it, then offers to run the
 * failed code again in the same place. The session keeps its variables, so nothing restarts.
 */
export function ComputeAddPackageAction(props: {
  readonly contextId: ComputeContextId;
  readonly sessionId: ComputeSessionId;
  readonly distribution: string;
  readonly runAgain?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [state, setState] = useState<"idle" | "adding" | "added" | "ran">("idle");
  const addLibrary = useAtomCommand(computeEnvironment.addPythonLibrary, { reportFailure: false });

  const add = async () => {
    const owner = getComputeContext(props.contextId);
    if (!owner || state !== "idle") return;
    setState("adding");
    const result = await addLibrary({
      environmentId: owner.environmentId,
      input: { cwd: owner.cwd, sessionId: props.sessionId, distribution: props.distribution },
    });
    if (result._tag === "Success") return setState("added");
    setState("idle");
    const cause = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: gt("Unable to add {name}", { name: props.distribution }),
      description:
        cause instanceof Error ? cause.message : gt("Check your connection and try again."),
    });
  };

  if (state === "ran") return null;
  if (state === "added")
    return props.runAgain === undefined ? (
      <span className="text-[11px] text-muted-foreground">
        <T>
          Added <Var>{props.distribution}</Var>. Run again to use it.
        </T>
      </span>
    ) : (
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          setState("ran");
          props.runAgain?.();
        }}
      >
        <Play />
        <T>Run again</T>
      </Button>
    );
  return (
    <Button size="xs" variant="outline" disabled={state === "adding"} onClick={() => void add()}>
      {state === "adding" ? <LoaderCircle className="animate-spin" /> : null}
      <T>
        Add <Var>{props.distribution}</Var>
      </T>
    </Button>
  );
}

/** One click replaces this tab's session with managed Python; never an installer or a retry. */
export function ComputeDependencyRecoveryAction(props: {
  readonly contextId: ComputeContextId;
  readonly session: ComputeSessionRecord;
  readonly moduleName: string;
  readonly executable: string;
  readonly onSettled: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const binding = useComputeContextStore((state) => state.bindings[props.contextId]);
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimes, {
    reportFailure: false,
  });
  const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
  const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });
  const getSession = useAtomQueryRunner(computeEnvironment.session, {
    reportFailure: false,
    refresh: true,
  });

  const recover = async () => {
    if (inFlight.current) return;
    const owner = getComputeContext(props.contextId);
    if (!owner || owner.sessionId !== props.session.sessionId || owner.lifecycle !== "live") return;
    inFlight.current = true;
    setBusy(true);
    return await (async () => {
      const result = await replaceComputeContextSession({
        contextId: props.contextId,
        expectedSession: props.session,
        replacementSessionId: ComputeSessionId.make(randomUUID()),
        getSession,
        stopSession,
        startSession,
        prepareRuntime: async () => {
          const runtimes = await refreshRuntimes({
            environmentId: owner.environmentId,
            input: { cwd: owner.cwd, refresh: true },
          });
          const target = managedDependencyRuntime({
            moduleName: props.moduleName,
            session: props.session,
            inspection: runtimes._tag === "Success" ? runtimes.value : null,
          });
          if (!target || target.executable !== props.executable) {
            throw new Error(
              "The managed Python environment or its packages changed. Check Scientific Computing settings before trying again.",
            );
          }
          // Runtime inspection can be slow. Read the exact session afterward,
          // so an earlier idle snapshot cannot authorize stopping newly busy work.
          const session = await getSession({
            environmentId: owner.environmentId,
            input: { cwd: owner.cwd, sessionId: props.session.sessionId },
          });
          if (
            session._tag !== "Success" ||
            session.value?.sessionId !== props.session.sessionId ||
            session.value.generation !== props.session.generation ||
            session.value.languageId !== props.session.languageId ||
            session.value.runtime?.executable !== props.session.runtime?.executable ||
            session.value.status !== "ready" ||
            session.value.activity !== "idle"
          ) {
            throw new Error(
              "The session changed or is busy. Wait for it to finish, then try again.",
            );
          }
          return { languageId: target.languageId, executable: target.executable };
        },
      });
      if (result.kind === "failed") {
        toastManager.add({
          type: "error",
          title: gt("Unable to start managed Python"),
          description: result.error,
        });
      }
    })().finally(() => {
      inFlight.current = false;
      setBusy(false);
      props.onSettled();
    });
  };

  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <Button
        size="xs"
        variant="outline"
        disabled={
          busy ||
          binding?.lifecycle !== "live" ||
          binding.sessionId !== props.session.sessionId ||
          props.session.status !== "ready" ||
          props.session.activity !== "idle"
        }
        onClick={() => void recover()}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : null}
        <T>Use managed Python</T>
      </Button>
      <span className="text-[11px] text-muted-foreground">
        <T>Variables reset</T>
      </span>
    </span>
  );
}
