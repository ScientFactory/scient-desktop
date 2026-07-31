// FILE: threadHierarchy.ts
// Purpose: Deterministic, cycle-safe traversal over parent-linked subagent thread trees.
// Exports: collectSubagentDescendants, collectSubagentSubtreeRoots

interface HierarchyThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
}

/**
 * Collects every descendant reachable from `rootThreadId`, breadth-first and
 * excluding the root. Visited tracking keeps corrupt self-links and cycles
 * from hanging lifecycle commands or returning the root as its own child.
 */
export function collectSubagentDescendants<T extends HierarchyThread>(
  threads: readonly T[],
  rootThreadId: T["id"],
): T[] {
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) continue;
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings) {
      siblings.push(thread);
    } else {
      childrenByParentId.set(parentThreadId, [thread]);
    }
  }

  const descendants: T[] = [];
  const visitedThreadIds = new Set<string>([rootThreadId]);
  const queue: string[] = [rootThreadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentThreadId = queue[index];
    if (parentThreadId === undefined) break;
    for (const child of childrenByParentId.get(parentThreadId) ?? []) {
      if (visitedThreadIds.has(child.id)) continue;
      visitedThreadIds.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

/**
 * Returns the minimum deterministic set of roots whose subtrees cover the
 * supplied threads. Children with a parent outside the supplied set become
 * roots. A corrupt cycle has no natural root, so the first input member is
 * retained as a synthetic root and its component is covered exactly once.
 */
export function collectSubagentSubtreeRoots<T extends HierarchyThread>(threads: readonly T[]): T[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) continue;
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings) {
      siblings.push(thread);
    } else {
      childrenByParentId.set(parentThreadId, [thread]);
    }
  }
  const roots: T[] = [];
  const coveredThreadIds = new Set<string>();

  const addRoot = (root: T) => {
    if (coveredThreadIds.has(root.id)) return;
    roots.push(root);
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current || coveredThreadIds.has(current.id)) continue;
      coveredThreadIds.add(current.id);
      queue.push(...(childrenByParentId.get(current.id) ?? []));
    }
  };

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null || !threadById.has(parentThreadId)) {
      addRoot(thread);
    }
  }

  for (const thread of threads) {
    addRoot(thread);
  }

  return roots;
}
