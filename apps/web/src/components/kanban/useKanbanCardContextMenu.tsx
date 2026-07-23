// FILE: useKanbanCardContextMenu.tsx
// Purpose: Right-click context menu for kanban cards, mirroring the sidebar thread
//          menu (rename / pin / copy path / copy id / archive / delete). Reuses the
//          same shared primitives the sidebar uses (native contextMenu, clipboard,
//          worktree cleanup, rename flow) instead of duplicating its action logic.
// Layer: Kanban UI hook
// Exports: useKanbanCardContextMenu

import type { ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useCallback, useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { RenameThreadDialog } from "~/components/RenameThreadDialog";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { reconcileDeletedThreadFromClient } from "~/lib/deletedThreadClientReconciliation";
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
    const thread = getThreadFromState(useStore.getState(), threadId);
    if (!thread) return;
    if (isThreadRunningTurn(thread)) {
      setFeedback({
        tone: "error",
        title: "Cannot archive",
        description: "Stop the running session before archiving this thread.",
      });
      return;
    }
    // Archived threads leave the board's thread feed, so a live optimistic
    // dispatch entry could never reconcile — drop it with the card.
    useKanbanUiStore.getState().clearOptimisticDispatch(threadId);
    await api.orchestration.dispatchCommand({
      type: "thread.archive",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const deleteCardThread = useCallback(
    async (card: KanbanCard) => {
      // A deleted thread can never reconcile its optimistic dispatch — drop the
      // entry first so no phantom In Progress card survives the deletion.
      useKanbanUiStore.getState().clearOptimisticDispatch(card.threadId);
      // Local-only draft (never promoted): just drop it from the draft store.
      if (card.thread === null) {
        clearDraftThread(card.threadId);
        return;
      }
      // A settled thread can have a separate draft card for its unsent composer prompt.
      if (isKanbanDraftOnlyCard(card)) {
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
      const project = state.projects.find((candidate) => candidate.id === thread.projectId) ?? null;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        getThreadsFromState(state),
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

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: card.threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      try {
        terminalRuntimeRegistry.disposeThread(card.threadId);
        await api.terminal.close({ threadId: card.threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: card.threadId,
      });
      void reconcileDeletedThreadFromClient({
        threadId: card.threadId,
        removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
      });
      clearDraftThread(card.threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(card.threadId);

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
              ? [{ id: "archive", label: "Archive", separatorBefore: true }]
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
            const confirmed = await api.dialogs.confirm(
              [
                `Archive thread "${card.title}"?`,
                "Archived threads are hidden from the sidebar but can be restored later.",
              ].join("\n"),
            );
            if (!confirmed) return;
          }
          await archiveCardThread(card.threadId);
          return;
        }
        if (clicked !== "delete") return;
        if (settings.confirmThreadDelete) {
          const confirmed = await api.dialogs.confirm(
            deletesOnlyDraft
              ? `Delete this draft? This removes its unsent prompt.`
              : [
                  `Delete thread "${card.title}"?`,
                  "This permanently clears conversation history for this thread.",
                ].join("\n"),
          );
          if (!confirmed) return;
        }
        await deleteCardThread(card);
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
