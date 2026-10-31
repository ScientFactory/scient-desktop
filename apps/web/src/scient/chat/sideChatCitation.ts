import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ComposerCitation, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { createContext, useEffect, useRef } from "react";
import { create } from "zustand";

import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

/** The chat a quote goes to. */
export type CitationDestination = "chat" | "side-chat";

/** Sends a quote to a side chat. Null where the conversation offers none. */
export const SideChatCitationContext = createContext<((citation: ComposerCitation) => void) | null>(
  null,
);

// A side chat's composer may not be mounted yet, so quotes wait here for it.
const useSideChatInbox = create<{
  readonly byThread: Readonly<Record<string, ReadonlyArray<ComposerCitation>>>;
}>(() => ({ byThread: {} }));

/** The side chat a quote joins: the one showing, else the newest tab, else none. */
function openSideChatId(parentRef: ScopedThreadRef): ThreadId | null {
  const { surfaces, activeSurfaceId } = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    parentRef,
  );
  const sideChats = surfaces.flatMap((surface) => (surface.kind === "side-chat" ? [surface] : []));
  return (
    sideChats.find((surface) => surface.id === activeSurfaceId)?.threadId ??
    sideChats.at(-1)?.threadId ??
    null
  );
}

async function citeInSideChat(
  parentRef: ScopedThreadRef,
  citation: ComposerCitation,
  startSideChat: () => Promise<boolean>,
  starting: { current: Promise<boolean> | null },
) {
  if (openSideChatId(parentRef) === null) {
    // Two quotes picked while it starts both join the same side chat.
    starting.current ??= startSideChat().finally(() => {
      starting.current = null;
    });
    if (!(await starting.current)) return;
  }
  const threadId = openSideChatId(parentRef);
  if (threadId === null) return;
  useRightPanelStore.getState().openSideChat(parentRef, threadId);
  const key = scopedThreadKey({ environmentId: parentRef.environmentId, threadId });
  useSideChatInbox.setState(({ byThread }) => ({
    byThread: { ...byThread, [key]: [...(byThread[key] ?? []), citation] },
  }));
}

/** Sends quotes to the side chat from `parentRef`, starting one when none is open. */
export function useCiteInSideChat(
  parentRef: ScopedThreadRef | null,
  startSideChat: () => Promise<boolean>,
) {
  const starting = useRef<Promise<boolean> | null>(null);
  return useStableCallback(async (citation: ComposerCitation) => {
    if (parentRef) await citeInSideChat(parentRef, citation, startSideChat, starting);
  });
}

function takeWaitingCitations(key: string): ReadonlyArray<ComposerCitation> {
  const { [key]: citations = [], ...rest } = useSideChatInbox.getState().byThread;
  useSideChatInbox.setState({ byThread: rest });
  return citations;
}

/** Adds quotes waiting for this thread to its composer. */
export function useSideChatCitationInbox(
  threadRef: ScopedThreadRef,
  cite: (citation: ComposerCitation) => boolean,
) {
  const key = scopedThreadKey(threadRef);
  const waiting = useSideChatInbox((state) => state.byThread[key] !== undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves queued quotes into the composer editor
  useEffect(() => {
    if (!waiting) return;
    // Read here, not from render: StrictMode replays this effect.
    for (const citation of takeWaitingCitations(key)) {
      if (cite(citation)) continue;
      toastManager.add({
        type: "warning",
        title: "Could not add the quote",
        description: "The side chat's input is not ready. Select the text and try again.",
      });
    }
  }, [cite, key, waiting]);
}
