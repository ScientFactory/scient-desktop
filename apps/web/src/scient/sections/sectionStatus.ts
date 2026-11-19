import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../../components/Sidebar.logic";

type StatusThread = Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof resolveSidebarThreadStatus>[0];

/** Most urgent first: a project folder's dot order, plus waiting, which folders leave quiet. */
const SECTION_STATUS_KINDS = ["attention", "failed", "done", "working", "waiting"] as const;
export type SectionStatusKind = (typeof SECTION_STATUS_KINDS)[number];

function threadStatusKind(thread: StatusThread): SectionStatusKind | null {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "attention";
    case "failed":
      return "failed";
    case "preparing":
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "ready":
      return hasUnseenCompletion(thread) ? "done" : null;
  }
}

/** Thread counts per status kind, most urgent first; quiet threads are left out. */
export function summarizeSectionStatus(
  threads: readonly StatusThread[],
): ReadonlyArray<{ readonly kind: SectionStatusKind; readonly count: number }> {
  const counts = new Map<SectionStatusKind, number>();
  for (const thread of threads) {
    const kind = threadStatusKind(thread);
    if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return SECTION_STATUS_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ kind, count }];
  });
}
