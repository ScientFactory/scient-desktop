import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  MessageId,
  OrchestrationForkWorkspaceMode,
  RunId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  hasPendingForkPdfContinuity,
  restoreForkPdfContinuity,
  subscribeForkPdfContinuity,
} from "~/components/scient-fork/forkViewContinuity";
import {
  isForkLandingPending,
  isForkLandingReady,
  settleForkLanding,
  subscribeForkLanding,
} from "~/components/scient-fork/forkLanding";
import { useScientThreadFork, type ForkSource } from "~/components/scient-fork/useScientThreadFork";
import type { TimelineLatestRun } from "~/components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "~/session-logic";
import type { ChatMessage, Thread } from "~/types";

import { findLatestCompletedAssistantMessageId } from "./forkCheckpointMessages";

/** A fork the user asked for, from the thread it was asked on. */
export type ForkCommandTarget = {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly workspaceMode: OrchestrationForkWorkspaceMode;
} & (
  | {
      readonly kind: "assistant-response";
      readonly messageId: MessageId | null;
      /** The latest response, resolved by the server when the fork starts. */
      readonly latest: boolean;
      /** "Continue in a new chat" also moves the unsent composer draft. */
      readonly composerDraft: boolean;
    }
  | {
      readonly kind: "user-message";
      readonly messageId: MessageId;
      readonly message: ChatMessage;
    }
  // SCIENT-FORK: the running turn with the work it has done so far.
  | { readonly kind: "running-turn"; readonly runId: RunId }
);

type RequestFork = (target: ForkCommandTarget) => void;

function forkSourceFor(target: ForkCommandTarget): ForkSource {
  switch (target.kind) {
    case "running-turn":
      return { kind: "running-turn", runId: target.runId };
    case "assistant-response":
      return { kind: "assistant-response", messageId: target.messageId, latest: target.latest };
    case "user-message":
      return {
        kind: "user-message",
        messageId: target.messageId,
        prompt: target.message.text,
        attachments: target.message.attachments ?? [],
      };
  }
}

const confirmSkippedImages = (names: ReadonlyArray<string>) =>
  requestConfirmDialog(
    `Fork without these images?\nThese images could not be read: ${names.join(", ")}. The fork keeps the message text and the readable images.`,
  ) ?? Promise.resolve(false);

/** One-click forks for the chat's active thread. */
export function useChatViewForkCommand(input: {
  readonly activeThread: Thread | null | undefined;
  readonly navigate: Parameters<typeof useScientThreadFork>[0]["navigate"];
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
}) {
  const { activeThread, navigate, serverConfigs } = input;
  const { isForking: isForkingThread, forkFromMessage } = useScientThreadFork({
    origin: activeThread ?? null,
    navigate,
    supported:
      activeThread != null &&
      serverConfigs.get(activeThread.environmentId)?.environment.capabilities.threadForkOptions ===
        true,
  });
  // The thread's ref and folder are known later in the chat's render.
  const context = useRef<{
    readonly activeThreadRef: ScopedThreadRef | null;
    readonly activeWorkspaceRoot: string | undefined;
  }>({ activeThreadRef: null, activeWorkspaceRoot: undefined });
  const requestFork: RequestFork = (target) => {
    if (
      activeThread == null ||
      target.threadId !== activeThread.id ||
      target.environmentId !== activeThread.environmentId
    )
      return;
    const { activeThreadRef, activeWorkspaceRoot } = context.current;
    void forkFromMessage(
      forkSourceFor(target),
      {
        workspaceMode: target.workspaceMode,
        confirmSkippedImages,
        ...(target.kind === "assistant-response" && target.composerDraft && activeThreadRef
          ? { composerDraftSource: activeThreadRef }
          : {}),
      },
      activeWorkspaceRoot,
    );
  };
  const setContext = (next: typeof context.current) => {
    context.current = next;
  };
  return { isForkingThread, requestFork, setContext };
}

export type ChatViewForkCommand = ReturnType<typeof useChatViewForkCommand>;

/** Gives the chat's fork requests the thread ref and folder known later in its render. */
export function ScientChatForkContext(input: {
  readonly fork: ChatViewForkCommand;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeWorkspaceRoot: string | undefined;
}) {
  const { setContext } = input.fork;
  const { activeThreadRef, activeWorkspaceRoot } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the fork request context ref in step with the chat's thread and folder for click handlers
  useLayoutEffect(() => {
    setContext({ activeThreadRef, activeWorkspaceRoot });
  }, [setContext, activeThreadRef, activeWorkspaceRoot]);
  return null;
}

/** The composer's fork command: the running turn while it works, else the latest answer. */
export function createForkConversationCommand(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly readTimelineEntries?: () => ReadonlyArray<TimelineEntry>;
  readonly activeLatestRun: TimelineLatestRun | null;
  readonly activeRunningTurnId: RunId | null;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly requestFork: RequestFork;
}) {
  const {
    timelineEntries,
    activeLatestRun,
    activeRunningTurnId,
    activeThreadId,
    activeThreadEnvironmentId,
    requestFork,
  } = input;
  return (options?: {
    readonly preserveComposerDraft?: boolean;
    readonly workspaceMode?: OrchestrationForkWorkspaceMode;
  }) => {
    if (!activeThreadId || !activeThreadEnvironmentId) return;
    const latestCompletedAssistantMessageId = findLatestCompletedAssistantMessageId({
      timelineEntries: input.readTimelineEntries?.() ?? timelineEntries,
      latestRun: activeLatestRun,
      runningRunId: activeRunningTurnId,
    });

    // While the agent works, a fork carries its work in progress.
    if (activeRunningTurnId !== null && !options?.preserveComposerDraft) {
      requestFork({
        threadId: activeThreadId,
        environmentId: activeThreadEnvironmentId,
        workspaceMode: options?.workspaceMode ?? "local",
        kind: "running-turn",
        runId: activeRunningTurnId,
      });
      return;
    }
    requestFork({
      threadId: activeThreadId,
      environmentId: activeThreadEnvironmentId,
      workspaceMode: options?.workspaceMode ?? "local",
      kind: "assistant-response",
      messageId: latestCompletedAssistantMessageId,
      latest: true,
      composerDraft: options?.preserveComposerDraft === true,
    });
  };
}

/** A fork's inherited baseline: where its marker sits and which thread it came from. */
export function deriveForkTimelineBaseline(input: {
  readonly activeThread: Thread | null | undefined;
  readonly serverVisibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>;
}) {
  const { activeThread, serverVisibleTurnItems } = input;
  const hasForkBaseline = activeThread?.lineage.relationshipToParent === "fork";
  const forkOriginThreadId =
    activeThread?.source.forkLineage?.originThreadId ??
    (hasForkBaseline ? (activeThread?.lineage.parentThreadId ?? undefined) : undefined);
  const forkBaselineAssistantMessageId = (() => {
    const recorded = activeThread?.source.forkLineage?.baselineAssistantMessageId;
    if (recorded != null) return recorded;
    const inherited = serverVisibleTurnItems.findLast(
      (row) => row.visibility === "inherited" && row.item.type === "assistant_message",
    )?.item;
    return inherited?.type === "assistant_message" ? inherited.messageId : null;
  })();
  return { hasForkBaseline, forkOriginThreadId, forkBaselineAssistantMessageId };
}

/** Timeline row actions: fork at one response or prompt, here or into a new worktree. */
export function createForkMessageCommands(input: {
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly activeRunningTurnId: RunId | null;
  readonly readTimelineEntries: () => ReadonlyArray<TimelineEntry>;
  readonly requestFork: RequestFork;
}) {
  const { activeThreadId, activeThreadEnvironmentId, requestFork } = input;
  const onForkAssistantMessage = (
    sourceAssistantMessageId: MessageId,
    workspaceMode: OrchestrationForkWorkspaceMode = "local",
  ) => {
    if (!activeThreadId || !activeThreadEnvironmentId) return;
    requestFork({
      threadId: activeThreadId,
      environmentId: activeThreadEnvironmentId,
      workspaceMode,
      kind: "assistant-response",
      messageId: sourceAssistantMessageId,
      latest: false,
      composerDraft: false,
    });
  };
  const onForkUserMessage = (
    message: ChatMessage,
    workspaceMode: OrchestrationForkWorkspaceMode = "local",
  ) => {
    if (!activeThreadId || !activeThreadEnvironmentId) return;
    requestFork({
      threadId: activeThreadId,
      environmentId: activeThreadEnvironmentId,
      workspaceMode,
      kind: "user-message",
      messageId: message.id,
      message,
    });
  };
  const onForkFromRun = async (source: { sourceThreadId: ThreadId; runId: RunId }) => {
    if (!activeThreadId || !activeThreadEnvironmentId || source.sourceThreadId !== activeThreadId)
      return;
    if (source.runId === input.activeRunningTurnId) {
      requestFork({
        threadId: activeThreadId,
        environmentId: activeThreadEnvironmentId,
        workspaceMode: "local",
        kind: "running-turn",
        runId: source.runId,
      });
      return;
    }
    const answer = input
      .readTimelineEntries()
      .findLast(
        (entry) =>
          entry.kind === "message" &&
          entry.message.role === "assistant" &&
          entry.message.runId === source.runId &&
          !entry.message.streaming,
      );
    if (answer?.kind === "message") onForkAssistantMessage(answer.message.id);
  };
  return { onForkAssistantMessage, onForkUserMessage, onForkFromRun };
}

/**
 * Hold only the fork's panel until deferred PDF positions apply: opening a reader records its own
 * position immediately and could overwrite them. Other threads/later folder changes must not
 * remount the panel.
 */
export function useForkPdfContinuityPending(
  activeThreadRef: ScopedThreadRef | null,
  activeWorkspaceRoot: string | undefined,
): boolean {
  const forkPdfContinuityPending = useSyncExternalStore(
    subscribeForkPdfContinuity,
    () => activeThreadRef !== null && hasPendingForkPdfContinuity(activeThreadRef),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores fork PDF continuity over the environment connection once the destination workspace root is known
  useLayoutEffect(() => {
    if (!activeThreadRef || !forkPdfContinuityPending || activeWorkspaceRoot === undefined) return;
    restoreForkPdfContinuity({
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      destinationWorkspaceRoot: activeWorkspaceRoot,
    });
  }, [activeThreadRef, activeWorkspaceRoot, forkPdfContinuityPending]);
  return forkPdfContinuityPending;
}

/**
 * Remembers a fork landing through its timeout so it reveals once, until the
 * user leaves that route.
 */
export function useForkLanding(routeThreadKey: string) {
  const pending = useSyncExternalStore(
    subscribeForkLanding,
    () => isForkLandingPending(routeThreadKey),
    () => false,
  );
  const [landedThreadKey, setLandedThreadKey] = useState<string | null>(null);
  if (pending && landedThreadKey !== routeThreadKey) {
    setLandedThreadKey(routeThreadKey);
  } else if (!pending && landedThreadKey !== null && landedThreadKey !== routeThreadKey) {
    setLandedThreadKey(null);
  }
  const landed = pending || landedThreadKey === routeThreadKey;
  return {
    pending,
    landed,
  };
}

export type ForkLanding = ReturnType<typeof useForkLanding>;

/**
 * Keeps a landing fork's messages invisible, still laid out so the list can
 * measure and position them, and shows them once with a short fade when the
 * fork is ready. Its composer's load status stays out of view meanwhile, so
 * the status row cannot appear and then leave after the messages show.
 */
export function useForkLandingReveal(input: {
  readonly landing: ForkLanding;
  readonly threadKey: string;
  readonly threadExists: boolean;
  readonly threadDeleted: boolean;
  readonly detailLoaded: boolean;
  readonly displayedThreadKey: string | null;
  readonly timelineEmpty: boolean;
}) {
  const { landing, ...readiness } = input;
  // Which thread the timeline has finished positioning, reported only while landing.
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(null);
  const ready = landing.pending && isForkLandingReady({ ...readiness, positionedThreadKey });
  const { threadKey } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles the fork-landing registry entry once the landing reports ready
  useLayoutEffect(() => {
    if (ready) settleForkLanding(threadKey);
  }, [ready, threadKey]);
  return {
    messagesClassName: landing.pending
      ? "opacity-0"
      : landing.landed
        ? "transition-opacity duration-150 ease-out motion-reduce:transition-none"
        : undefined,
    onPositionedThreadKeyChange: landing.pending ? setPositionedThreadKey : undefined,
    syncStatusHidden: landing.pending,
  };
}
