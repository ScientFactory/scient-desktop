import type {
  OrchestrationV2AppThread,
  RoomGuestView,
  RoomParticipantId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import { activeParticipant } from "./threadRoomDecider.ts";

/** The room as one participant sees it: who is in it and what they may do. Null once they left. */
export function roomGuestView(
  thread: OrchestrationV2AppThread,
  participantId: RoomParticipantId,
  online: ReadonlyArray<RoomParticipantId>,
  now: DateTime.Utc,
): RoomGuestView | null {
  const room = thread.room ?? null;
  const me = activeParticipant(room, participantId, now);
  if (room === null || me === null) return null;
  const onlineIds = new Set(online);
  return {
    roomId: room.id,
    title: thread.title,
    me: { participantId: me.id, name: me.name, role: me.role },
    participants: room.participants.flatMap((participant) =>
      participant.name === null
        ? []
        : [
            {
              participantId: participant.id,
              name: participant.name,
              role: participant.role,
              online: onlineIds.has(participant.id),
            },
          ],
    ),
    expiresAt: me.expiresAt,
  };
}
