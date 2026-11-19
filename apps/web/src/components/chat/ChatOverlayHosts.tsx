import type {
  DeviceServiceState,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, Var } from "gt-react";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { DeviceSetup } from "../device/DeviceSetup";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";
import { findRevertCheckpoint } from "../../session-logic";
import { registerThreadOverlay } from "./threadOverlayRetention";

/**
 * Open state for overlays the chat view hosts. It lives in atoms rather than
 * ChatView state so opening or closing one renders only its host, not the
 * whole chat chrome. Each entry carries the thread it was opened for; a host
 * shows only its own thread's entry, and leaving that thread's route drops it.
 */
type ThreadOverlayAtom<T> = Atom.Writable<{ readonly threadKey: string; readonly value: T } | null>;

function makeThreadOverlayAtom<T>(label: string): ThreadOverlayAtom<T> {
  const atom = Atom.make<{ readonly threadKey: string; readonly value: T } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`chat:${label}`),
  );
  registerThreadOverlay((threadKey) => {
    const entry = appAtomRegistry.get(atom);
    if (entry !== null && entry.threadKey !== threadKey) closeThreadOverlay(atom);
  });
  return atom;
}

function closeThreadOverlay<T>(atom: ThreadOverlayAtom<T>): void {
  appAtomRegistry.set(atom, null);
}

function useThreadOverlay<T>(atom: ThreadOverlayAtom<T>, threadKey: string | null): T | null {
  const entry = useAtomValue(atom);
  return threadKey !== null && entry?.threadKey === threadKey ? entry.value : null;
}

const pullRequestThreadDialogAtom = makeThreadOverlayAtom<{
  readonly initialReference: string | null;
  readonly key: number;
}>("pull-request-thread-dialog");

export function openPullRequestThreadDialog(threadKey: string, reference?: string): void {
  appAtomRegistry.set(pullRequestThreadDialogAtom, {
    threadKey,
    value: { initialReference: reference ?? null, key: Date.now() },
  });
}

export function PullRequestThreadDialogHost(props: {
  readonly threadKey: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
    pullRequestUrl: string;
  }) => Promise<void> | void;
}) {
  const state = useThreadOverlay(pullRequestThreadDialogAtom, props.threadKey);
  if (state === null) return null;
  return (
    <PullRequestThreadDialog
      key={state.key}
      open
      environmentId={props.environmentId}
      threadId={props.threadId}
      cwd={props.cwd}
      initialReference={state.initialReference}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(pullRequestThreadDialogAtom);
      }}
      onPrepared={props.onPrepared}
    />
  );
}

const deviceSetupDialogAtom = makeThreadOverlayAtom<true>("device-setup-dialog");

export function openDeviceSetupDialog(threadKey: string): void {
  appAtomRegistry.set(deviceSetupDialogAtom, { threadKey, value: true });
}

export function DeviceSetupDialogHost(props: {
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly state: DeviceServiceState;
}) {
  const open = useThreadOverlay(deviceSetupDialogAtom, props.threadKey) !== null;
  const { threadRef } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(deviceSetupDialogAtom);
      }}
    >
      <WizardPopup>
        {threadRef ? (
          <DeviceSetup
            environmentId={threadRef.environmentId}
            state={props.state}
            onComplete={() => {
              useRightPanelStore.getState().open(threadRef, "device");
              closeThreadOverlay(deviceSetupDialogAtom);
            }}
          />
        ) : null}
      </WizardPopup>
    </Dialog>
  );
}

const branchRestoreConfirmAtom = makeThreadOverlayAtom<true>("branch-restore-confirm");

export function openBranchRestoreConfirm(threadKey: string): void {
  appAtomRegistry.set(branchRestoreConfirmAtom, { threadKey, value: true });
}

export function BranchRestoreConfirmHost(props: {
  readonly threadKey: string | null;
  readonly threadBranch: string;
  readonly canWriteSourceControl: boolean;
  readonly onConfirm: () => void;
}) {
  const open = useThreadOverlay(branchRestoreConfirmAtom, props.threadKey) !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(branchRestoreConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>
              Switch to{" "}
              <code className="font-medium">
                <Var>{props.threadBranch}</Var>
              </code>
              ?
            </T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>
              You have uncommitted changes. They'll carry over to the other branch, or block the
              switch if they conflict.
            </T>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button
            variant="default"
            disabled={!props.canWriteSourceControl}
            onClick={() => {
              closeThreadOverlay(branchRestoreConfirmAtom);
              props.onConfirm();
            }}
          >
            <T>Switch branch</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

interface PendingRevert {
  readonly turnCount: number;
  readonly messageId: MessageId;
  // SCIENT-FORK: why the last attempt failed, for a host that stays open while reverting.
  readonly error?: string;
}

const revertConfirmAtom = makeThreadOverlayAtom<PendingRevert>("revert-confirm");

export function openRevertConfirm(threadKey: string, pending: PendingRevert): void {
  appAtomRegistry.set(revertConfirmAtom, { threadKey, value: pending });
}

// SCIENT-FORK:START — a host that stays open while reverting is closed, or shown the failure,
// by the revert it started. False when the dialog is no longer open for that thread (its route
// was left), so the caller reports the failure another way.
export function settleRevertConfirm(threadKey: string, error: string | null): boolean {
  const entry = appAtomRegistry.get(revertConfirmAtom);
  if (entry === null || entry.threadKey !== threadKey) return false;
  appAtomRegistry.set(
    revertConfirmAtom,
    error === null ? null : { threadKey, value: { ...entry.value, error } },
  );
  return true;
}
// SCIENT-FORK:END

export function RevertConfirmHost(props: {
  readonly threadKey: string;
  readonly checkpoints: OrchestrationV2ThreadProjection["checkpoints"] | undefined;
  readonly worktreePath: string | null;
  readonly onConfirm: (turnCount: number, messageId: MessageId, restoreFiles: boolean) => void;
  // SCIENT-FORK:START
  /**
   * Given, the dialog stays open while the revert runs, its actions disabled, until
   * settleRevertConfirm closes it or records why it failed.
   */
  readonly reverting?: boolean;
  /**
   * Given, files that cannot be restored are explained in the description and
   * "Revert files too" is hidden rather than disabled.
   */
  readonly describeUnrestorableFiles?: (reason: "outside-worktree" | "no-snapshot") => string;
  /** Shown under the description, with the last failure if there was one. */
  readonly renderDetails?: (error: string | undefined) => ReactNode;
  // SCIENT-FORK:END
}) {
  const pending = useThreadOverlay(revertConfirmAtom, props.threadKey);
  // The server refuses file restore outside an isolated worktree.
  const canRestoreFiles =
    pending !== null &&
    props.worktreePath !== null &&
    findRevertCheckpoint(props.checkpoints ?? [], pending.turnCount)?.status === "ready";
  // SCIENT-FORK:START
  const keepsOpen = props.reverting !== undefined;
  const reverting = props.reverting === true;
  const unrestorableFiles =
    pending === null || canRestoreFiles || props.describeUnrestorableFiles === undefined
      ? null
      : props.describeUnrestorableFiles(
          findRevertCheckpoint(props.checkpoints ?? [], pending.turnCount)?.status !== "ready"
            ? "no-snapshot"
            : "outside-worktree",
        );
  // SCIENT-FORK:END
  const confirm = (restoreFiles: boolean) => {
    if (pending === null || (restoreFiles && !canRestoreFiles)) return;
    // SCIENT-FORK: a host that stays open closes when the revert settles.
    if (!keepsOpen) closeThreadOverlay(revertConfirmAtom);
    props.onConfirm(pending.turnCount, pending.messageId, restoreFiles);
  };
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        // SCIENT-FORK: a running revert cannot be dismissed.
        if (!open && !reverting) closeThreadOverlay(revertConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Edit from here?</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* SCIENT-FORK:START */}
            {unrestorableFiles === null ? (
              <T>
                Rewind chat to before this message. Your prompt and attachments return to the
                composer. “Revert files too” also undoes your own edits.
              </T>
            ) : (
              <>
                <T>
                  Rewind chat to before this message. Your prompt and attachments return to the
                  composer.
                </T>{" "}
                {unrestorableFiles}
              </>
            )}
            {/* SCIENT-FORK:END */}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* SCIENT-FORK: e.g. diagnostics or the last failure. */}
        {pending === null ? null : props.renderDetails?.(pending.error)}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={reverting} />}>
            <T>Cancel</T>
          </AlertDialogClose>
          {/* SCIENT-FORK:START */}
          {unrestorableFiles !== null ? null : (
            <Button
              variant="destructive-outline"
              disabled={!canRestoreFiles || reverting}
              onClick={() => confirm(true)}
            >
              <T>Revert files too</T>
            </Button>
          )}
          <Button disabled={reverting} onClick={() => confirm(false)}>
            {unrestorableFiles === null ? <T>Revert and keep changes</T> : <T>Rewind chat</T>}
          </Button>
          {/* SCIENT-FORK:END */}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
