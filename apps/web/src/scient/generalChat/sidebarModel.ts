interface ScientSidebarThread {
  readonly projectId: string | null;
}

interface ScientSidebarShelves<T> {
  readonly pinned: ReadonlyArray<T>;
  readonly active: ReadonlyArray<T>;
  readonly snoozed: ReadonlyArray<T>;
  readonly settled: ReadonlyArray<T>;
}

function splitShelf<T extends ScientSidebarThread>(threads: ReadonlyArray<T>) {
  const project: T[] = [];
  const general: T[] = [];
  for (const thread of threads) {
    (thread.projectId === null ? general : project).push(thread);
  }
  return { project, general } as const;
}

/** General Chat remains visible while the ordinary sidebar is scoped to a project. */
export function isScientSidebarThreadVisible(input: {
  readonly archivedAt: string | null;
  readonly projectId: string | null;
  readonly projectMatchesScope: boolean;
}): boolean {
  return input.archivedAt === null && (input.projectId === null || input.projectMatchesScope);
}

/**
 * Owns the General Chat projection of T3's already-classified sidebar shelves.
 * Lifecycle classification and row rendering stay generic; this adapter owns
 * only the Scient product split, search order, and active-section reveal key.
 */
export function buildScientGeneralChatSidebarModel<T extends ScientSidebarThread>(input: {
  readonly shelves: ScientSidebarShelves<T>;
  readonly activeDraft: {
    readonly draftId: string;
    readonly projectId: string | null;
  } | null;
  readonly routeThreadKey: string | null;
  readonly getThreadKey: (thread: T) => string;
}) {
  const pinned = splitShelf(input.shelves.pinned);
  const active = splitShelf(input.shelves.active);
  const snoozed = splitShelf(input.shelves.snoozed);
  const settled = splitShelf(input.shelves.settled);
  const generalChatThreads = [
    ...pinned.general,
    ...active.general,
    ...snoozed.general,
    ...settled.general,
  ];
  const generalChatThreadKeys = new Set(generalChatThreads.map(input.getThreadKey));
  const activeGeneralChatKey =
    input.activeDraft?.projectId === null
      ? `draft:${input.activeDraft.draftId}`
      : input.routeThreadKey !== null && generalChatThreadKeys.has(input.routeThreadKey)
        ? input.routeThreadKey
        : null;

  return {
    pinnedThreads: pinned.project,
    activeThreads: active.project,
    snoozedThreads: snoozed.project,
    settledThreads: settled.project,
    generalPinnedThreads: pinned.general,
    generalActiveThreads: active.general,
    generalSnoozedThreads: snoozed.general,
    generalSettledThreads: settled.general,
    generalChatThreads,
    activeGeneralChatKey,
    searchableThreads: [
      ...generalChatThreads,
      ...pinned.project,
      ...active.project,
      ...snoozed.project,
      ...settled.project,
    ],
  } as const;
}
