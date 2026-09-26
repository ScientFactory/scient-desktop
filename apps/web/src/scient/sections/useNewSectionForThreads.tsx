import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useCallback, useState } from "react";

import { useThreadSectionActions } from "./actions";
import { useThreadSectionCatalog } from "./catalog";
import { NewSectionDialog } from "./NewSectionDialog";

/**
 * "New section…" from a thread menu: asks for a name, creates the section
 * (or reuses one with that name) and files the threads into it in one step.
 */
export function useNewSectionForThreads(): {
  readonly request: (threadRefs: readonly ScopedThreadRef[]) => void;
  readonly requestForThread: (threadRef: ScopedThreadRef) => void;
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
  const requestForThread = useCallback((threadRef: ScopedThreadRef) => {
    setRequestKey((key) => key + 1);
    setPending([threadRef]);
  }, []);

  const submit = useCallback(
    async (name: string) => {
      const section = await catalog.create(name);
      if (section === null) return false;
      if (pending !== null && pending.length > 0) {
        await moveThreadsToSection(pending, section.id);
      }
      return true;
    },
    [catalog, moveThreadsToSection, pending],
  );

  return {
    request,
    requestForThread,
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
