import type {
  ScopedThreadRef,
  ThreadSection,
  ThreadSectionId,
  ThreadSectionProjectRef,
} from "@t3tools/contracts";
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
 * Creates a section for `threadRefs` and files them into it: the one step
 * behind both the dialog and the Sections view's inline row. Resolves the
 * section, or null when it could not be created (nothing is filed then).
 * Filing reports its own failures and offers Undo.
 */
export async function createSectionAndFile(input: {
  readonly name: string;
  readonly threadRefs: readonly ScopedThreadRef[];
  readonly scopeProjectRefs: readonly ThreadSectionProjectRef[] | null;
  readonly create: (name: string, origin: SectionOrigin) => Promise<ThreadSection | null>;
  readonly moveThreadsToSection: (
    threadRefs: readonly ScopedThreadRef[],
    sectionId: ThreadSectionId,
  ) => Promise<boolean>;
}): Promise<ThreadSection | null> {
  const section = await input.create(
    input.name,
    sectionOriginForThreads(input.threadRefs, input.scopeProjectRefs),
  );
  if (section === null) return null;
  if (input.threadRefs.length > 0) await input.moveThreadsToSection(input.threadRefs, section.id);
  return section;
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
      const section = await createSectionAndFile({
        name,
        threadRefs: pending ?? [],
        scopeProjectRefs: readSidebarSectionScope(),
        create: catalog.create,
        moveThreadsToSection,
      });
      return section !== null;
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
