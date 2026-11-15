import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  RoomInviteError,
  RoomInviteInput,
  RoomInviteLinkInput,
  RoomInviteResult,
  RoomPresence,
  RoomPresenceInput,
} from "./threadRoom.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_THREAD_ROOM_WS_METHODS = {
  threadRoomInvite: "threadRoom.invite",
  threadRoomInviteLink: "threadRoom.inviteLink",
  threadRoomPresence: "threadRoom.presence",
} as const;

export const WsThreadRoomInviteRpc = Rpc.make(SCIENT_THREAD_ROOM_WS_METHODS.threadRoomInvite, {
  payload: RoomInviteInput,
  success: RoomInviteResult,
  error: Schema.Union([RoomInviteError, EnvironmentAuthorizationError]),
});

/** The link of an invite nobody has opened yet, to copy it again. */
export const WsThreadRoomInviteLinkRpc = Rpc.make(
  SCIENT_THREAD_ROOM_WS_METHODS.threadRoomInviteLink,
  {
    payload: RoomInviteLinkInput,
    success: RoomInviteResult,
    error: Schema.Union([RoomInviteError, EnvironmentAuthorizationError]),
  },
);

export const WsThreadRoomPresenceRpc = Rpc.make(SCIENT_THREAD_ROOM_WS_METHODS.threadRoomPresence, {
  payload: RoomPresenceInput,
  success: RoomPresence,
  stream: true,
  error: EnvironmentAuthorizationError,
});
