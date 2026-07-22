// FILE: forkTitle.ts
// Purpose: Resolve deterministic server-owned titles for conversation forks.
// Layer: Server orchestration domain logic

export interface ForkTitleThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly forkSourceThreadId?: string | null | undefined;
  readonly sidechatSourceThreadId?: string | null | undefined;
  readonly forkTitleBase?: string | null | undefined;
  readonly forkTitleOrdinal?: number | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

export interface ResolvedForkTitle {
  readonly title: string;
  readonly forkTitleBase: string;
  readonly forkTitleOrdinal: number;
}

export function formatForkTitle(base: string, ordinal: number): string {
  return `${base} (${ordinal})`;
}

function isStoredForkOrdinal(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 2;
}

function usesAutomaticForkTitle(thread: ForkTitleThread): thread is ForkTitleThread & {
  readonly forkTitleBase: string;
  readonly forkTitleOrdinal: number;
} {
  return (
    thread.forkTitleBase !== null &&
    thread.forkTitleBase !== undefined &&
    isStoredForkOrdinal(thread.forkTitleOrdinal)
  );
}

function resolveForkFamilyRootId(
  thread: ForkTitleThread,
  threadsById: ReadonlyMap<string, ForkTitleThread>,
): string {
  let current = thread;
  const visited = new Set<string>();

  // Automatic lineage is persisted in the fork metadata. Title updates clear
  // that metadata in both projectors, so a rename remains a permanent family
  // boundary even when the user later restores the generated title verbatim.
  while (current.forkSourceThreadId && usesAutomaticForkTitle(current)) {
    if (visited.has(current.id)) {
      return [...visited, current.id].toSorted()[0] ?? current.id;
    }
    visited.add(current.id);

    const sourceId = current.forkSourceThreadId;
    const source = threadsById.get(sourceId);
    if (!source) {
      return sourceId;
    }
    current = source;
  }

  return current.id;
}

export function resolveNextForkTitle(input: {
  readonly sourceThread: ForkTitleThread;
  readonly threads: ReadonlyArray<ForkTitleThread>;
}): ResolvedForkTitle {
  const source = input.sourceThread;
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread]));
  if (!threadsById.has(source.id)) {
    threadsById.set(source.id, source);
  }

  const forkTitleBase = usesAutomaticForkTitle(source) ? source.forkTitleBase : source.title;
  const familyRootId = resolveForkFamilyRootId(source, threadsById);

  let highestOrdinal = 1;
  for (const thread of input.threads) {
    if (!usesAutomaticForkTitle(thread)) {
      continue;
    }
    if (
      thread.projectId !== source.projectId ||
      thread.sidechatSourceThreadId ||
      thread.forkTitleBase !== forkTitleBase ||
      resolveForkFamilyRootId(thread, threadsById) !== familyRootId
    ) {
      continue;
    }
    highestOrdinal = Math.max(highestOrdinal, thread.forkTitleOrdinal);
  }

  if (highestOrdinal >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Fork title ordinal is exhausted for '${forkTitleBase}'.`);
  }
  const forkTitleOrdinal = highestOrdinal + 1;
  return {
    title: formatForkTitle(forkTitleBase, forkTitleOrdinal),
    forkTitleBase,
    forkTitleOrdinal,
  };
}
