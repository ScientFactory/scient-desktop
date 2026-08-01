// FILE: archivedThreadDelete.ts
// Purpose: Coordinates archived-thread deletion with immediate local removal.
// Layer: Web orchestration helper
// Exports: archivedThreadDeleteConfirmation, deleteArchivedThreadFromClient,
// deleteArchivedThreadsFromClient

import type { NativeApi, OrchestrationThreadShell, ProjectId, ThreadId } from "@synara/contracts";
import { buildThreadHierarchyIndex } from "@synara/shared/threadHierarchy";

import { reconcileDeletedThreadsFromClient } from "./deletedThreadClientReconciliation";
import { newCommandId } from "./utils";

export function archivedThreadDeleteConfirmation(threadTitle: string, conversationCount: number) {
  if (conversationCount <= 1) {
    return `Permanently delete "${threadTitle}"?\n\nThis will remove the conversation and its history forever.`;
  }
  return [
    `Permanently delete "${threadTitle}" and its ${conversationCount - 1} sub-agent conversations?`,
    "",
    `This will remove all ${conversationCount} conversations and their histories forever.`,
  ].join("\n");
}

interface DeleteArchivedThreadFromClientInput {
  api: Pick<NativeApi, "browser" | "orchestration" | "projects">;
  threadId: ThreadId;
  descendantThreadIds?: ReadonlyArray<ThreadId>;
  removeDeletedThreadFromClientState: (threadId: ThreadId) => void;
}

interface DeleteArchivedThreadsFromClientInput extends Omit<
  DeleteArchivedThreadFromClientInput,
  "threadId"
> {
  threadIds: ReadonlyArray<ThreadId>;
  snapshotThreads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "parentThreadId" | "projectId">
  >;
}

export interface ArchivedThreadDeletionFamily {
  readonly rootThreadId: ThreadId;
  readonly descendantThreadIds: readonly ThreadId[];
}

export function buildArchivedThreadFamilyScopes<
  T extends {
    readonly id: ThreadId;
    readonly parentThreadId?: ThreadId | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(
  threads: readonly T[],
): {
  readonly archivedRoots: readonly T[];
  readonly deleteCountByRootId: ReadonlyMap<ThreadId, number>;
  readonly restoreCountByRootId: ReadonlyMap<ThreadId, number>;
} {
  const archivedThreads = threads.filter((thread) => (thread.archivedAt ?? null) !== null);
  const archivedHierarchy = buildThreadHierarchyIndex(archivedThreads);
  const fullHierarchy = buildThreadHierarchyIndex(threads);
  const archivedRoots = archivedHierarchy.collectSubtreeRoots();
  return {
    archivedRoots,
    deleteCountByRootId: new Map(
      archivedRoots.map(
        (root) => [root.id, fullHierarchy.collectDescendants(root.id).length + 1] as const,
      ),
    ),
    restoreCountByRootId: new Map(
      archivedRoots.map(
        (root) => [root.id, archivedHierarchy.collectDescendants(root.id).length + 1] as const,
      ),
    ),
  };
}

export function buildArchivedThreadDeletionFamilies(input: {
  readonly selectedThreadIds: readonly ThreadId[];
  readonly snapshotThreads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "parentThreadId" | "projectId">
  >;
}): ArchivedThreadDeletionFamily[] {
  const selectedThreadIdSet = new Set(input.selectedThreadIds);
  const snapshotThreadsByProjectId = new Map<
    ProjectId,
    Array<Pick<OrchestrationThreadShell, "id" | "parentThreadId" | "projectId">>
  >();
  for (const thread of input.snapshotThreads) {
    const projectThreads = snapshotThreadsByProjectId.get(thread.projectId);
    if (projectThreads) {
      projectThreads.push(thread);
    } else {
      snapshotThreadsByProjectId.set(thread.projectId, [thread]);
    }
  }

  const families: ArchivedThreadDeletionFamily[] = [];
  for (const projectThreads of snapshotThreadsByProjectId.values()) {
    const selectedProjectThreads = projectThreads.filter((thread) =>
      selectedThreadIdSet.has(thread.id),
    );
    const selectedHierarchy = buildThreadHierarchyIndex(selectedProjectThreads);
    const snapshotHierarchy = buildThreadHierarchyIndex(projectThreads);
    for (const root of selectedHierarchy.collectSubtreeRoots()) {
      families.push({
        rootThreadId: root.id,
        descendantThreadIds: snapshotHierarchy
          .collectDescendants(root.id)
          .map((thread) => thread.id)
          .toReversed(),
      });
    }
  }
  return families;
}

// Deletes the archived thread on the server, then removes it from local projections.
export async function deleteArchivedThreadFromClient(
  input: DeleteArchivedThreadFromClientInput,
): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "thread.delete",
    commandId: newCommandId(),
    threadId: input.threadId,
    cascadeDescendants: true,
    expectedDescendantThreadIds: [...(input.descendantThreadIds ?? [])],
  });
  await reconcileDeletedThreadsFromClient({
    api: input.api,
    threadIds: [...(input.descendantThreadIds ?? []), input.threadId],
    removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
  });
}

// Deletes a group of archived threads and reconciles successful ids once at the end.
export async function deleteArchivedThreadsFromClient(
  input: DeleteArchivedThreadsFromClientInput,
): Promise<void> {
  const families = buildArchivedThreadDeletionFamilies({
    selectedThreadIds: input.threadIds,
    snapshotThreads: input.snapshotThreads,
  });
  if (families.length === 0) {
    return;
  }

  const deletedThreadIds: ThreadId[] = [];
  try {
    for (const family of families) {
      await input.api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: family.rootThreadId,
        cascadeDescendants: true,
        expectedDescendantThreadIds: [...family.descendantThreadIds],
      });
      deletedThreadIds.push(...family.descendantThreadIds, family.rootThreadId);
    }
  } finally {
    await reconcileDeletedThreadsFromClient({
      api: input.api,
      threadIds: deletedThreadIds,
      removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
    });
  }
}
