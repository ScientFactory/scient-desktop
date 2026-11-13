import { useAtomValue } from "@effect/atom-react";
import type { RoomReplyTarget, ScopedThreadRef, ThreadRoom } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";

const NO_ROOM = Atom.make<ThreadRoom | null>(null);
const roomState = Atom.family((_key: string) =>
  Atom.make<{
    readonly to: "agent" | "people";
    readonly replyTo: RoomReplyTarget | null;
  }>({ to: "agent", replyTo: null }).pipe(Atom.keepAlive),
);

export function useThreadRoom(ref: ScopedThreadRef | null) {
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  const atom = useMemo(() => {
    if (environmentId === undefined || threadId === undefined) return NO_ROOM;
    let previous: ThreadRoom | null = null;
    return Atom.make((get) => {
      const next =
        get(environmentThreadDetails.threadAtom({ environmentId, threadId }))?.projection.thread
          .room ?? null;
      if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
      return previous;
    });
  }, [environmentId, threadId]);
  return useAtomValue(atom);
}

export function useRoomComposerState(key: string) {
  return useAtomValue(roomState(key));
}

export function readRoomComposerState(key: string) {
  return appAtomRegistry.get(roomState(key));
}

export function setRoomDestination(key: string, to: "agent" | "people") {
  const current = appAtomRegistry.get(roomState(key));
  appAtomRegistry.set(roomState(key), { to, replyTo: to === "agent" ? null : current.replyTo });
}

export function clearRoomReply(key: string) {
  const current = appAtomRegistry.get(roomState(key));
  appAtomRegistry.set(roomState(key), { ...current, replyTo: null });
}

export function replyInRoom(ref: ScopedThreadRef, replyTo: RoomReplyTarget) {
  appAtomRegistry.set(roomState(scopedThreadKey(ref.environmentId, ref.threadId)), {
    to: "people",
    replyTo,
  });
}
