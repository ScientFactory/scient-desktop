// FILE: archivedThreadDelete.ts
// Purpose: Coordinates archived-thread deletion with immediate local removal.
// Layer: Web orchestration helper
// Exports: archivedThreadDeleteConfirmation, deleteArchivedThreadFromClient,
// deleteArchivedThreadsFromClient

import type { NativeApi, OrchestrationThreadShell, ProjectId, ThreadId } from "@synara/contracts";
import { buildThreadHierarchyIndex } from "@synara/shared/threadHierarchy";

import { reconcileDeletedThreadsFromClient } from "./deletedThreadClientReconciliation";
import { newCommandId } from "./utils";

function normalizeWorktreePath(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

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

export interface ArchivedThreadDeletionPlan {
  readonly families: readonly ArchivedThreadDeletionFamily[];
  readonly threadIds: readonly ThreadId[];
}

export interface ArchivedWorktreeDeletionPlan extends ArchivedThreadDeletionPlan {
  readonly linkedArchivedThreadIds: readonly ThreadId[];
  readonly linkedActiveThreadCount: number;
  readonly unexpectedDescendantThreadIds: readonly ThreadId[];
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
    if (selectedProjectThreads.length === 0) continue;
    const projectThreadById = new Map(projectThreads.map((thread) => [thread.id, thread] as const));
    const snapshotHierarchy = buildThreadHierarchyIndex(projectThreads);
    const selectedProjectThreadIdSet = new Set(selectedProjectThreads.map((thread) => thread.id));
    let roots = selectedProjectThreads.filter((thread) => {
      const visitedThreadIds = new Set<ThreadId>([thread.id]);
      let parentThreadId = thread.parentThreadId ?? null;
      while (parentThreadId !== null && !visitedThreadIds.has(parentThreadId)) {
        if (selectedProjectThreadIdSet.has(parentThreadId)) return false;
        visitedThreadIds.add(parentThreadId);
        parentThreadId = projectThreadById.get(parentThreadId)?.parentThreadId ?? null;
      }
      return true;
    });
    // A corrupt selected cycle has no natural root. Retain one deterministic
    // synthetic root so the cycle is covered once instead of emitting no work.
    roots = roots.length > 0 ? roots : [selectedProjectThreads[0]!];
    const coveredThreadIds = new Set<ThreadId>();
    for (const root of roots) {
      if (coveredThreadIds.has(root.id)) continue;
      const descendantThreadIds = snapshotHierarchy
        .collectDescendants(root.id)
        .map((thread) => thread.id)
        .toReversed()
        .filter((threadId) => !coveredThreadIds.has(threadId));
      descendantThreadIds.forEach((threadId) => coveredThreadIds.add(threadId));
      coveredThreadIds.add(root.id);
      families.push({
        rootThreadId: root.id,
        descendantThreadIds,
      });
    }
  }
  return families;
}

export function buildArchivedThreadDeletionPlan(input: {
  readonly selectedThreadIds: readonly ThreadId[];
  readonly snapshotThreads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "parentThreadId" | "projectId">
  >;
}): ArchivedThreadDeletionPlan {
  const families = buildArchivedThreadDeletionFamilies(input);
  const threadIds: ThreadId[] = [];
  const seenThreadIds = new Set<ThreadId>();
  for (const family of families) {
    for (const threadId of [...family.descendantThreadIds, family.rootThreadId]) {
      if (seenThreadIds.has(threadId)) continue;
      seenThreadIds.add(threadId);
      threadIds.push(threadId);
    }
  }
  return { families, threadIds };
}

export function buildArchivedWorktreeDeletionPlan(input: {
  readonly worktreePath: string;
  readonly snapshotThreads: ReadonlyArray<
    Pick<
      OrchestrationThreadShell,
      | "id"
      | "parentThreadId"
      | "projectId"
      | "archivedAt"
      | "worktreePath"
      | "associatedWorktreePath"
    >
  >;
}): ArchivedWorktreeDeletionPlan {
  const targetWorktreePath = normalizeWorktreePath(input.worktreePath);
  const linkedThreads =
    targetWorktreePath === null
      ? []
      : input.snapshotThreads.filter((thread) =>
          [
            normalizeWorktreePath(thread.worktreePath),
            normalizeWorktreePath(thread.associatedWorktreePath),
          ].includes(targetWorktreePath),
        );
  const linkedArchivedThreadIds = linkedThreads
    .filter((thread) => (thread.archivedAt ?? null) !== null)
    .map((thread) => thread.id);
  const linkedArchivedThreadIdSet = new Set(linkedArchivedThreadIds);
  const deletionPlan = buildArchivedThreadDeletionPlan({
    selectedThreadIds: linkedArchivedThreadIds,
    snapshotThreads: input.snapshotThreads,
  });
  return {
    ...deletionPlan,
    linkedArchivedThreadIds,
    linkedActiveThreadCount: linkedThreads.length - linkedArchivedThreadIds.length,
    unexpectedDescendantThreadIds: deletionPlan.threadIds.filter(
      (threadId) => !linkedArchivedThreadIdSet.has(threadId),
    ),
  };
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
  const { families } = buildArchivedThreadDeletionPlan({
    selectedThreadIds: input.threadIds,
    snapshotThreads: input.snapshotThreads,
  });
  if (families.length === 0) {
    return;
  }

  const deletedThreadIds = new Set<ThreadId>();
  try {
    for (const family of families) {
      await input.api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: family.rootThreadId,
        cascadeDescendants: true,
        expectedDescendantThreadIds: [...family.descendantThreadIds],
      });
      family.descendantThreadIds.forEach((threadId) => deletedThreadIds.add(threadId));
      deletedThreadIds.add(family.rootThreadId);
    }
  } finally {
    await reconcileDeletedThreadsFromClient({
      api: input.api,
      threadIds: [...deletedThreadIds],
      removeDeletedThreadFromClientState: input.removeDeletedThreadFromClientState,
    });
  }
}
