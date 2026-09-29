import type { ScopedThreadRef, ThreadSectionProjectRef } from "@t3tools/contracts";
import { type ReactNode, useCallback, useState } from "react";

import { readThreadShell } from "../../state/entities";
import { useThreadSectionActions } from "./actions";
import { useThreadSectionCatalog } from "./catalog";
import type { SectionOrigin } from "./logic";
import { NewSectionDialog } from "./NewSectionDialog";
import { readSidebarSectionScope } from "./sidebarScope";

/**
 * What a section created for `threadRefs` records: their environments, and
 * as the projects it was created for, their projects plus the sidebar's
 * selected project (`scopeProjectRefs`, null under All projects).
 */
export function sectionOriginForThreads(
  threadRefs: readonly ScopedThreadRef[],
  scopeProjectRefs: readonly ThreadSectionProjectRef[] | null,
): SectionOrigin {
  const threadProjects = threadRefs.flatMap((ref) => {
    const projectId = readThreadShell(ref)?.projectId ?? null;
    return projectId === null ? [] : [{ environmentId: ref.environmentId, projectId }];
  });
  return {
    environmentIds: threadRefs.map((ref) => ref.environmentId),
    createdInProjects: [...(scopeProjectRefs ?? []), ...threadProjects],
  };
}

/**
 * "New section…" from a thread menu: asks for a name, creates the section
 * (or reuses one with that name) and files the threads into it in one step.
 */
export function useNewSectionForThreads(): {
  readonly request: (threadRefs: readonly ScopedThreadRef[]) => void;
  readonly dialog: ReactNode;
} {
  const catalog = useThreadSectionCatalog();
  const { moveThreadsToSection } = useThreadSectionActions();
  const [pending, setPending] = useState<readonly ScopedThreadRef[] | null>(null);
  const [requestKey, setRequestKey] = useState(0);

  const request = useCallback((threadRefs: readonly ScopedThreadRef[]) => {
    setRequestKey((key) => key + 1);
    setPending(threadRefs);
  }, []);

  const submit = useCallback(
    async (name: string) => {
      const threadRefs = pending ?? [];
      const section = await catalog.create(
        name,
        sectionOriginForThreads(threadRefs, readSidebarSectionScope()),
      );
      if (section === null) return false;
      if (threadRefs.length > 0) await moveThreadsToSection(threadRefs, section.id);
      return true;
    },
    [catalog, moveThreadsToSection, pending],
  );

  return {
    request,
    dialog: (
      <NewSectionDialog
        open={pending !== null}
        requestKey={requestKey}
        threadCount={pending?.length ?? 0}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onSubmit={submit}
      />
    ),
  };
}
