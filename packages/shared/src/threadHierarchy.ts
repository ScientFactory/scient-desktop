// FILE: threadHierarchy.ts
// Purpose: Deterministic, cycle-safe traversal over parent-linked subagent thread trees.
// Exports: buildThreadHierarchyIndex, collectSubagentDescendants, collectSubagentSubtreeRoots

interface HierarchyThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
}

export interface ThreadHierarchyIndex<T extends HierarchyThread> {
  readonly collectDescendants: (rootThreadId: T["id"]) => T[];
  readonly collectSubtreeRoots: () => T[];
}

/**
 * Indexes parent links once so callers that inspect several subtrees do not
 * repeatedly scan the complete thread collection. The returned traversals are
 * cycle-safe and preserve the input order of siblings and roots.
 */
export function buildThreadHierarchyIndex<T extends HierarchyThread>(
  threads: readonly T[],
): ThreadHierarchyIndex<T> {
  const threadById = new Map<string, T>();
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    threadById.set(thread.id, thread);
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) continue;
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings) {
      siblings.push(thread);
    } else {
      childrenByParentId.set(parentThreadId, [thread]);
    }
  }

  const collectDescendants = (rootThreadId: T["id"]): T[] => {
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
  };

  const collectSubtreeRoots = (): T[] => {
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

    for (const thread of threadById.values()) {
      const parentThreadId = thread.parentThreadId ?? null;
      if (parentThreadId === null || !threadById.has(parentThreadId)) {
        addRoot(thread);
      }
    }

    for (const thread of threadById.values()) {
      addRoot(thread);
    }

    return roots;
  };

  return { collectDescendants, collectSubtreeRoots };
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
  return buildThreadHierarchyIndex(threads).collectDescendants(rootThreadId);
}

/**
 * Returns the minimum deterministic set of roots whose subtrees cover the
 * supplied threads. Children with a parent outside the supplied set become
 * roots. A corrupt cycle has no natural root, so the first input member is
 * retained as a synthetic root and its component is covered exactly once.
 */
export function collectSubagentSubtreeRoots<T extends HierarchyThread>(threads: readonly T[]): T[] {
  return buildThreadHierarchyIndex(threads).collectSubtreeRoots();
}
