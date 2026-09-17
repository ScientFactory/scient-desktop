import { useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { ComputeSessionId, type ComputeSessionRecord } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";
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

/** A confirmed lifecycle action, not an installer or an automatic retry. */
export function ComputeDependencyRecoveryAction(props: {
  readonly contextId: ComputeContextId;
  readonly session: ComputeSessionRecord;
  readonly moduleName: string;
  readonly executable: string;
  readonly onSettled: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const anchor = useRef<HTMLButtonElement>(null);
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
    try {
      const result = await replaceComputeContextSession({
        contextId: props.contextId,
        expectedSession: props.session,
        replacementSessionId: ComputeSessionId.make(randomUUID()),
        getSession,
        stopSession,
        startSession,
        prepareRuntime: async () => {
          const [runtimes, session] = await Promise.all([
            refreshRuntimes({
              environmentId: owner.environmentId,
              input: { cwd: owner.cwd, refresh: true },
            }),
            getSession({
              environmentId: owner.environmentId,
              input: { cwd: owner.cwd, sessionId: props.session.sessionId },
            }),
          ]);
          if (
            session._tag !== "Success" ||
            session.value?.sessionId !== props.session.sessionId ||
            session.value.generation !== props.session.generation ||
            session.value.status !== "ready" ||
            session.value.activity !== "idle"
          ) {
            throw new Error(
              "The session changed or is busy. Wait for it to finish, then try again.",
            );
          }
          const target = managedDependencyRuntime({
            moduleName: props.moduleName,
            session: session.value,
            inspection: runtimes._tag === "Success" ? runtimes.value : null,
          });
          if (!target || target.executable !== props.executable) {
            throw new Error(
              "The managed Python environment or its packages changed. Check Scientific Computing settings before trying again.",
            );
          }
          return { languageId: target.languageId, executable: target.executable };
        },
      });
      if (result.kind === "started") {
        toastManager.add({
          type: "success",
          title: "Managed Python session ready",
          description:
            "The namespace is empty. Run your file when ready; past runs remain in history.",
        });
      } else if (result.kind === "failed") {
        toastManager.add({
          type: "error",
          title: "Unable to start managed Python",
          description: result.error,
        });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      props.onSettled();
    }
  };

  return (
    <>
      <Button
        ref={anchor}
        size="xs"
        variant="ghost-muted"
        className="mt-1"
        disabled={
          busy ||
          binding?.lifecycle !== "live" ||
          binding.sessionId !== props.session.sessionId ||
          props.session.status !== "ready" ||
          props.session.activity !== "idle"
        }
        onClick={() => setConfirming(true)}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : null}
        {busy ? "Starting managed Python…" : "Start a new session with managed Python…"}
      </Button>
      <ContextualConfirmation
        open={confirming}
        onOpenChange={setConfirming}
        anchor={anchor}
        title="Start a new managed Python session?"
        description="This stops this tab’s current session and clears its in-memory variables. Run history is kept. No code is rerun, and your default Python environment stays unchanged."
        confirmLabel="Start new session"
        onConfirm={() => void recover()}
        busy={busy}
      />
    </>
  );
}
