// FILE: useKanbanCardContextMenu.tsx
// Purpose: Right-click context menu for kanban cards, mirroring the sidebar thread
//          menu (rename / pin / copy path / copy id / archive / delete). Reuses the
//          same shared primitives the sidebar uses (native contextMenu, clipboard,
//          worktree cleanup, rename flow) instead of duplicating its action logic.
// Layer: Kanban UI hook
// Exports: useKanbanCardContextMenu

import type { ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { collectSubagentDescendants } from "@synara/shared/threadHierarchy";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useCallback, useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { RenameThreadDialog } from "~/components/RenameThreadDialog";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { reconcileDeletedThreadsFromClient } from "~/lib/deletedThreadClientReconciliation";
import { gitRemoveWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { pinActionLabel } from "~/lib/pin";
import { dispatchThreadRename } from "~/lib/threadRename";
import { newCommandId } from "~/lib/utils";
import { activityManager } from "~/notifications/activityStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useKanbanUiStore } from "../../kanbanUiStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { isThreadRunningTurn } from "../../session-logic";
import { getThreadFromState, getThreadsFromState } from "../../threadDerivation";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
} from "../../worktreeCleanup";
import { terminalRuntimeRegistry } from "../terminal/terminalRuntimeRegistry";
import { isKanbanDraftOnlyCard, type KanbanCard } from "./kanban.logic";
import type { KanbanFeedback } from "./KanbanInlineFeedback";

interface RenameTarget {
  threadId: ThreadId;
  title: string;
}

export interface KanbanCardContextMenuController {
  /** Attach to each card's `onContextMenu`. */
  onCardContextMenu: (card: KanbanCard, event: MouseEvent) => void;
  /** Render once near the board root. */
  renameDialog: React.ReactNode;
  /** Local result or error from the most recent card action. */
  feedback: KanbanFeedback | null;
  clearFeedback: () => void;
}

export function useKanbanCardContextMenu(): KanbanCardContextMenuController {
  const { settings } = useAppSettings();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [feedback, setFeedback] = useState<KanbanFeedback | null>(null);
  const clearFeedback = useCallback(() => setFeedback(null), []);

  const copyWithFeedback = useCallback(async (value: string, label: string) => {
    try {
      await copyTextToClipboard(value);
      setFeedback({ tone: "success", title: `${label} copied` });
    } catch (error) {
      setFeedback({
        tone: "error",
        title: `Failed to copy ${label.toLowerCase()}`,
        description: error instanceof Error ? error.message : "Clipboard access failed.",
      });
    }
  }, []);

  const resolveCardWorkspacePath = useCallback((card: KanbanCard): string | null => {
    const appState = useStore.getState();
    const project = appState.projects.find((candidate) => candidate.id === card.projectId) ?? null;
    return resolveThreadWorkspaceCwd({
      projectCwd: project?.cwd ?? null,
      envMode: card.envMode ?? undefined,
      worktreePath: card.worktreePath,
    });
  }, []);

  const archiveCardThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) {
      setFeedback({
        tone: "error",
        title: "Not connected",
        description: "Reconnect to the server before archiving.",
      });
      return;
    }
    const currentThreads = getThreadsFromState(useStore.getState());
    const thread = currentThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const subtreeThreads = [thread, ...collectSubagentDescendants(currentThreads, threadId)];
    const runningCount = subtreeThreads.filter(
      (candidate) =>
        candidate.session?.orchestrationStatus === "starting" || isThreadRunningTurn(candidate),
    ).length;
    if (runningCount > 0) {
      setFeedback({
        tone: "error",
        title: "Cannot archive",
        description:
          runningCount === 1
            ? "Wait for startup or stop the active turn in this conversation subtree before archiving it."
            : `Wait for startup or stop the ${runningCount} active sessions in this conversation subtree before archiving it.`,
      });
      return;
    }
    // Archived threads leave the board's thread feed, so a live optimistic
    // dispatch entry could never reconcile — drop it with the card.
    for (const subtreeThread of subtreeThreads) {
      useKanbanUiStore.getState().clearOptimisticDispatch(subtreeThread.id);
    }
    await api.orchestration.dispatchCommand({
      type: "thread.archive",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const deleteCardThread = useCallback(
    async (
      card: KanbanCard,
      options?: { readonly expectedDescendantThreadIds?: readonly ThreadId[] },
    ) => {
      // Local-only draft (never promoted): just drop it from the draft store.
      if (card.thread === null) {
        useKanbanUiStore.getState().clearOptimisticDispatch(card.threadId);
        clearDraftThread(card.threadId);
        return;
      }
      // A settled thread can have a separate draft card for its unsent composer prompt.
      if (isKanbanDraftOnlyCard(card)) {
        useKanbanUiStore.getState().clearOptimisticDispatch(card.threadId);
        clearComposerContent(card.threadId);
        return;
      }
      const api = readNativeApi();
      if (!api) {
        setFeedback({
          tone: "error",
          title: "Not connected",
          description: "Reconnect to the server before deleting this thread.",
        });
        return;
      }
      const state = useStore.getState();
      const thread = getThreadFromState(state, card.threadId);
      if (!thread) return;
      const allThreads = getThreadsFromState(state);
      const threadById = new Map(allThreads.map((candidate) => [candidate.id, candidate] as const));
      const expectedDescendantThreadIds =
        options?.expectedDescendantThreadIds ??
        collectSubagentDescendants(allThreads, card.threadId).map((candidate) => candidate.id);
      const subtreeThreads = [
        thread,
        ...expectedDescendantThreadIds.flatMap((descendantId) => {
          const descendant = threadById.get(descendantId);
          return descendant ? [descendant] : [];
        }),
      ];
      const project = state.projects.find((candidate) => candidate.id === thread.projectId) ?? null;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        allThreads.filter(
          (candidate) =>
            candidate.id === card.threadId ||
            !subtreeThreads.some((deletedThread) => deletedThread.id === candidate.id),
        ),
        card.threadId,
      );
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const shouldDeleteWorktree =
        orphanedWorktreePath !== null &&
        project !== null &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: card.threadId,
        cascadeDescendants: true,
        expectedDescendantThreadIds,
      });
      try {
        await api.terminal.close({ threadId: card.threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }
      await reconcileDeletedThreadsFromClient({
        api,
        threadIds: subtreeThreads.map((candidate) => candidate.id),
        removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
      });
      for (const deletedThread of subtreeThreads) {
        useKanbanUiStore.getState().clearOptimisticDispatch(deletedThread.id);
        terminalRuntimeRegistry.disposeThread(deletedThread.id);
        clearDraftThread(deletedThread.id);
        clearProjectDraftThreadById(deletedThread.projectId, deletedThread.id);
        clearTerminalState(deletedThread.id);
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !project) {
        return;
      }
      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: project.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const description = `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${
          error instanceof Error ? error.message : "Unknown error."
        }`;
        setFeedback({
          tone: "error",
          title: "Thread deleted, but worktree removal failed",
          description,
        });
        activityManager.publish({
          dedupeKey: `kanban:worktree-removal:${card.threadId}`,
          source: "system",
          status: "needs_attention",
          tone: "error",
          title: "Worktree removal failed",
          description,
        });
      }
    },
    [
      clearComposerContent,
      clearDraftThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      removeWorktreeMutation,
    ],
  );

  const setThreadPinned = useCallback(async (threadId: ThreadId, isPinned: boolean) => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Native API unavailable.");
    }
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      isPinned,
    });
  }, []);

  const onCardContextMenu = useCallback(
    (card: KanbanCard, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readNativeApi();
      if (!api) {
        setFeedback({
          tone: "error",
          title: "Not connected",
          description: "Reconnect to the server before using card actions.",
        });
        return;
      }
      const position = { x: event.clientX, y: event.clientY };
      const isDraftOnlyCard = isKanbanDraftOnlyCard(card);
      const isThreadBacked = card.thread !== null;
      const deletesOnlyDraft = !isThreadBacked || isDraftOnlyCard;
      const isThreadActionCard = isThreadBacked && !isDraftOnlyCard;
      const workspacePath = resolveCardWorkspacePath(card);

      void (async () => {
        const clicked = await api.contextMenu.show(
          [
            ...(isThreadActionCard
              ? [
                  { id: "rename", label: "Rename thread" },
                  {
                    id: "toggle-pin",
                    label: pinActionLabel("thread", card.thread?.isPinned ?? false),
                  },
                ]
              : []),
            ...(workspacePath
              ? [{ id: "copy-path", label: "Copy Path", separatorBefore: true }]
              : []),
            ...(isThreadBacked ? [{ id: "copy-thread-id", label: "Copy Thread ID" }] : []),
            ...(isThreadActionCard
              ? card.thread?.parentThreadId
                ? []
                : [{ id: "archive", label: "Archive", separatorBefore: true }]
              : []),
            {
              id: "delete",
              label: deletesOnlyDraft ? "Delete draft" : "Delete",
              destructive: true,
              separatorBefore: !isThreadActionCard,
            },
          ],
          position,
        );

        if (clicked === "rename" && isThreadActionCard && card.thread) {
          setRenameTarget({ threadId: card.threadId, title: card.thread.title });
          return;
        }
        if (clicked === "toggle-pin" && isThreadActionCard && card.thread) {
          const next = !card.thread.isPinned;
          void setThreadPinned(card.threadId, next).catch(() => {
            setFeedback({
              tone: "error",
              title: next ? "Unable to pin thread" : "Unable to unpin thread",
            });
          });
          return;
        }
        if (clicked === "copy-path") {
          if (!workspacePath) return;
          await copyWithFeedback(workspacePath, "Path");
          return;
        }
        if (clicked === "copy-thread-id") {
          await copyWithFeedback(card.threadId, "Thread ID");
          return;
        }
        if (clicked === "archive") {
          if (!isThreadActionCard) return;
          if (settings.confirmThreadArchive) {
            const conversationCount =
              collectSubagentDescendants(getThreadsFromState(useStore.getState()), card.threadId)
                .length + 1;
            const confirmed = await api.dialogs.confirm(
              [
                conversationCount === 1
                  ? `Archive thread "${card.title}"?`
                  : `Archive "${card.title}" with its ${conversationCount - 1} sub-agent conversations?`,
                "Archived threads are hidden from the sidebar but can be restored later.",
              ].join("\n"),
            );
            if (!confirmed) return;
          }
          await archiveCardThread(card.threadId);
          return;
        }
        if (clicked !== "delete") return;
        let confirmedDescendantThreadIds: readonly ThreadId[] | undefined;
        if (settings.confirmThreadDelete) {
          const storedThread = getThreadFromState(useStore.getState(), card.threadId);
          confirmedDescendantThreadIds = storedThread
            ? collectSubagentDescendants(
                getThreadsFromState(useStore.getState()),
                card.threadId,
              ).map((thread) => thread.id)
            : [];
          const conversationCount = confirmedDescendantThreadIds.length + 1;
          const confirmed = await api.dialogs.confirm(
            deletesOnlyDraft
              ? `Delete this draft? This removes its unsent prompt.`
              : conversationCount === 1
                ? [
                    `Delete thread "${card.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n")
                : [
                    `Delete "${card.title}" and its ${conversationCount - 1} sub-agent conversations?`,
                    `This permanently clears all ${conversationCount} conversation histories.`,
                  ].join("\n"),
          );
          if (!confirmed) return;
        }
        await deleteCardThread(card, {
          ...(confirmedDescendantThreadIds
            ? { expectedDescendantThreadIds: confirmedDescendantThreadIds }
            : {}),
        });
      })().catch((error: unknown) => {
        setFeedback({
          tone: "error",
          title: "Card action failed",
          description: error instanceof Error ? error.message : "Unexpected error.",
        });
      });
    },
    [
      archiveCardThread,
      copyWithFeedback,
      deleteCardThread,
      resolveCardWorkspacePath,
      setThreadPinned,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
    ],
  );

  const renameDialog = useMemo(
    () => (
      <RenameThreadDialog
        open={renameTarget !== null}
        currentTitle={renameTarget?.title ?? ""}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onSave={async (newTitle) => {
          if (!renameTarget) return;
          try {
            const outcome = await dispatchThreadRename({
              threadId: renameTarget.threadId,
              newTitle,
              unchangedTitles: [renameTarget.title],
            });
            if (outcome === "unavailable") {
              setFeedback({
                tone: "error",
                title: "Not connected",
                description: "Reconnect to the server before renaming.",
              });
              setRenameTarget(null);
              return;
            }
            setRenameTarget(null);
          } catch (error) {
            setFeedback({
              tone: "error",
              title: "Unable to rename thread",
              description: error instanceof Error ? error.message : "Unexpected error.",
            });
            setRenameTarget(null);
          }
        }}
      />
    ),
    [renameTarget],
  );

  return { onCardContextMenu, renameDialog, feedback, clearFeedback };
}
