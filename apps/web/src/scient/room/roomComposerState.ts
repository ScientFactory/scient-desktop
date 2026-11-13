import type { RoomReplyTarget } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Where the owner's next message goes in a thread with a room, and what it answers. */
export interface RoomComposerState {
  readonly to: "agent" | "people";
  readonly replyTo: RoomReplyTarget | null;
}

const INITIAL: RoomComposerState = { to: "agent", replyTo: null };

/** Per thread, by scoped thread key; each window keeps its own. */
export const roomComposerStateAtom = Atom.family((_threadKey: string) =>
  Atom.make<RoomComposerState>(INITIAL).pipe(
    Atom.keepAlive,
    Atom.withLabel("thread-room:composer"),
  ),
);

export function setRoomComposerState(
  threadKey: string,
  update: (current: RoomComposerState) => RoomComposerState,
): void {
  const atom = roomComposerStateAtom(threadKey);
  appAtomRegistry.set(atom, update(appAtomRegistry.get(atom)));
}

/** Replying to a person goes to people; the composer then shows what it answers. */
export function replyInRoom(threadKey: string, target: RoomReplyTarget): void {
  setRoomComposerState(threadKey, () => ({ to: "people", replyTo: target }));
}
