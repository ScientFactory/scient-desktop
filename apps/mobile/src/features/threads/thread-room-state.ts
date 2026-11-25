import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ThreadRoom } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";

const NO_ROOM = Atom.make<ThreadRoom | null>(null);
/** Whether this person's messages in a shared thread go straight to the agent; off by default. */
const roomDirect = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive));

export function useThreadRoom(ref: ScopedThreadRef | null) {
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  const atom = useMemo(() => {
    if (environmentId === undefined || threadId === undefined) return NO_ROOM;
    return Atom.make((get): ThreadRoom | null => {
      const next =
        get(environmentThreadDetails.threadAtom({ environmentId, threadId }))?.projection.thread
          .room ?? null;
      // An equal room keeps its identity, so readers do not re-render for a rebuilt copy.
      const previous = Option.getOrNull(get.self<ThreadRoom | null>());
      return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
    });
  }, [environmentId, threadId]);
  return useAtomValue(atom);
}

export function useRoomDirect(key: string) {
  return useAtomValue(roomDirect(key));
}

export function readRoomDirect(key: string) {
  return appAtomRegistry.get(roomDirect(key));
}

export function setRoomDirect(key: string, on: boolean) {
  appAtomRegistry.set(roomDirect(key), on);
}
