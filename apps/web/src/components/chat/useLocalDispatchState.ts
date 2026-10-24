import { type MessageId, type RuntimeRequestId } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { type ComposerSubmissionIntent } from "../../composer-logic";
import { type SessionPhase, type Thread } from "../../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../ChatView.logic";

export interface LocalDispatchActions {
  readonly beginLocalDispatch: (options?: {
    readonly preparingWorktree?: boolean;
    readonly submissionIntent?: ComposerSubmissionIntent;
  }) => void;
  readonly resetLocalDispatch: () => void;
}

export function useLocalDispatchState(input: {
  routeThreadKey: string;
  activeThread: Thread | undefined;
  activeLatestRun: Thread["latestRun"] | null;
  latestUserMessageId: MessageId | null;
  phase: SessionPhase;
  activePendingApproval: RuntimeRequestId | null;
  activePendingUserInput: RuntimeRequestId | null;
  threadError: string | null | undefined;
}) {
  const [dispatch, setDispatch] = useState<{
    threadKey: string;
    snapshot: LocalDispatchSnapshot;
  } | null>(null);
  const currentThreadKeyRef = useRef(input.routeThreadKey);
  useLayoutEffect(() => {
    currentThreadKeyRef.current = input.routeThreadKey;
  }, [input.routeThreadKey]);
  const localDispatch = dispatch?.threadKey === input.routeThreadKey ? dispatch.snapshot : null;

  const resetLocalDispatch: LocalDispatchActions["resetLocalDispatch"] = () => {
    setDispatch((current) => (current?.threadKey === input.routeThreadKey ? null : current));
  };

  const serverAcknowledgedLocalDispatch = hasServerAcknowledgedLocalDispatch({
    localDispatch,
    phase: input.phase,
    latestRun: input.activeLatestRun,
    latestUserMessageId: input.latestUserMessageId,
    runtime: input.activeThread?.runtime ?? null,
    hasPendingApproval: input.activePendingApproval !== null,
    hasPendingUserInput: input.activePendingUserInput !== null,
    threadError: input.threadError,
  });
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch: LocalDispatchActions["beginLocalDispatch"] = (options) => {
    if (currentThreadKeyRef.current !== input.routeThreadKey) return;
    const preparingWorktree = Boolean(options?.preparingWorktree);
    setDispatch((current) => {
      const active =
        !serverAcknowledgedLocalDispatch && current?.threadKey === input.routeThreadKey
          ? current.snapshot
          : null;
      if (active) {
        const submissionIntent = options?.submissionIntent ?? active.submissionIntent;
        return active.preparingWorktree === preparingWorktree &&
          active.submissionIntent === submissionIntent
          ? current
          : {
              threadKey: input.routeThreadKey,
              snapshot: { ...active, preparingWorktree, submissionIntent },
            };
      }
      return {
        threadKey: input.routeThreadKey,
        snapshot: createLocalDispatchSnapshot(input.activeThread, {
          ...options,
          latestUserMessageId: input.latestUserMessageId,
        }),
      };
    });
  };

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    // SCIENT-FORK: the working row waits for this dispatch's prompt to arrive.
    localDispatchLatestUserMessageId: activeLocalDispatch?.latestUserMessageId ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending: activeLocalDispatch?.submissionIntent === "background",
  };
}
