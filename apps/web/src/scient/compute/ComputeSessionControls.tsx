import type { ComputeSessionRecord, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { LoaderCircle, MoreHorizontal, Power, RotateCcw, Square } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { stopComputeContext } from "./computeContextCoordinator";
import {
  getComputeContext,
  useComputeContextStore,
  type ComputeContextBinding,
  type ComputeContextId,
} from "./computeContextStore";

type SessionCommand = "interrupt" | "restart" | "stop";

export function reportComputeFailure(
  title: string,
  result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
) {
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The compute operation failed.",
    }),
  );
}

/** Interrupt, restart and stop for the live session; each command targets the exact generation shown. */
export function ComputeSessionControls(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly session: ComputeSessionRecord;
  readonly contextId: ComputeContextId | undefined;
  readonly binding: ComputeContextBinding | null;
  readonly onSettled: () => void;
  /** Extra actions at the top of the session menu. */
  readonly menuItems?: ReactNode;
}) {
  const [operation, setOperation] = useState<SessionCommand | null>(null);
  const [confirmation, setConfirmation] = useState<{
    readonly kind: "restart" | "stop";
    readonly session: ComputeSessionRecord;
  } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const getSession = useAtomQueryRunner(computeEnvironment.session, {
    reportFailure: false,
    refresh: true,
  });
  const interruptSession = useAtomCommand(computeEnvironment.interruptSession, {
    reportFailure: false,
  });
  const restartSession = useAtomCommand(computeEnvironment.restartSession, {
    reportFailure: false,
  });
  const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });
  const closing =
    props.binding?.lifecycle === "closing" || props.binding?.lifecycle === "close-failed";

  const run = async (kind: SessionCommand, target: ComputeSessionRecord) => {
    if (
      props.contextId !== undefined &&
      getComputeContext(props.contextId)?.sessionId !== target.sessionId
    ) {
      toastManager.add({ type: "info", title: "The session changed" });
      return;
    }
    setOperation(kind);
    if (kind === "stop" && props.contextId !== undefined) {
      await stopComputeContext({ contextId: props.contextId, stopSession, getSession });
      setOperation((current) => (current === kind ? null : current));
      props.onSettled();
      return;
    }
    const command =
      kind === "interrupt" ? interruptSession : kind === "restart" ? restartSession : stopSession;
    const result = await command({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, sessionId: target.sessionId, expectedGeneration: target.generation },
    });
    setOperation((current) => (current === kind ? null : current));
    if (result._tag === "Success" && props.contextId !== undefined) {
      const binding = {
        contextId: props.contextId,
        sessionId: result.value.sessionId,
        generation: result.value.generation,
      };
      if (kind === "stop") useComputeContextStore.getState().markSessionTerminal(binding);
      else useComputeContextStore.getState().bindSession(binding);
    }
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      reportComputeFailure(`Unable to ${kind} compute`, result);
    }
    props.onSettled();
  };

  return (
    <div className="flex items-center gap-1">
      {props.session.activity === "busy" ? (
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Interrupt running code and keep session state"
          disabled={operation !== null || closing}
          onClick={() => void run("interrupt", props.session)}
        >
          {operation === "interrupt" ? <LoaderCircle className="animate-spin" /> : <Square />}
          Interrupt
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              ref={anchor}
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Session actions"
              disabled={operation === "stop" || closing}
            />
          }
        >
          {operation === "restart" || operation === "stop" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <MoreHorizontal />
          )}
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-44">
          {props.menuItems}
          <MenuItem
            disabled={
              operation !== null ||
              props.session.status !== "ready" ||
              props.session.lifetime === "fresh"
            }
            onClick={() => setConfirmation({ kind: "restart", session: props.session })}
          >
            <RotateCcw />
            Restart session
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            onClick={() => setConfirmation({ kind: "stop", session: props.session })}
          >
            <Power />
            Stop session
          </MenuItem>
        </MenuPopup>
      </Menu>
      <ContextualConfirmation
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        anchor={anchor}
        title={confirmation?.kind === "stop" ? "Stop this session?" : "Restart this session?"}
        description="Clears variables. Runs stay in Results."
        confirmLabel={confirmation?.kind === "stop" ? "Stop session" : "Restart session"}
        destructive={confirmation?.kind === "stop"}
        onConfirm={() => {
          if (confirmation !== null) void run(confirmation.kind, confirmation.session);
        }}
      />
    </div>
  );
}
