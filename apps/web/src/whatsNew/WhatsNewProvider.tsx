// FILE: whatsNew/WhatsNewProvider.tsx
// Purpose: Share one release-note state machine between the sidebar card and
// the root-owned dialog without coupling the sidebar to release persistence.

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

import { DialogCreateHandle } from "../components/ui/dialog";
import { useWhatsNew, type UseWhatsNewResult } from "./useWhatsNew";
import type { WhatsNewEntry } from "./logic";

export type WhatsNewDialogHandle = ReturnType<typeof DialogCreateHandle>;
export type WhatsNewContextValue = UseWhatsNewResult & {
  readonly dialogHandle: WhatsNewDialogHandle;
};

const WhatsNewContext = createContext<WhatsNewContextValue | null>(null);

// Base UI supports a detached trigger and dialog root through a shared handle.
// The sidebar card and root dialog intentionally live in different subtrees.
export function WhatsNewProvider({
  children,
  entries,
  currentVersion,
}: {
  readonly children: ReactNode;
  readonly entries?: readonly WhatsNewEntry[];
  readonly currentVersion?: string;
}) {
  const whatsNew = useWhatsNew({ entries, currentVersion });
  const [dialogHandle] = useState(() => DialogCreateHandle());
  const value = useMemo(() => ({ ...whatsNew, dialogHandle }), [dialogHandle, whatsNew]);
  return <WhatsNewContext.Provider value={value}>{children}</WhatsNewContext.Provider>;
}

export function useWhatsNewContext(): WhatsNewContextValue {
  const context = useContext(WhatsNewContext);
  if (context === null) {
    throw new Error("useWhatsNewContext must be used within WhatsNewProvider.");
  }
  return context;
}
