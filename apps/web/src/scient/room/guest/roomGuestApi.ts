import {
  OrchestrationV2ThreadHistoryPage,
  ROOM_ROUTE_PREFIX,
  RoomParticipantId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { roomUrl } from "./roomGuest.logic";

const decodeError = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));
const decodeJoin = Schema.decodeUnknownSync(Schema.Struct({ participantId: RoomParticipantId }));
const decodeHistory = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
);

export async function roomResponseError(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  return Option.match(decodeError(body), {
    onNone: () => "This room is not available. Ask the owner for a new link.",
    onSome: ({ message }) => message,
  });
}

export async function joinRoom(credential: string, name: string) {
  const response = await fetch(`${ROOM_ROUTE_PREFIX}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, name }),
  });
  if (!response.ok) throw new Error(await roomResponseError(response));
  return decodeJoin(await response.json()).participantId;
}

export async function postRoom(
  participantId: string,
  path: "messages" | "send" | "delete" | "stop",
  body: FormData | { readonly itemId: string } | undefined,
): Promise<string | null> {
  try {
    const response = await fetch(roomUrl(path, participantId), {
      method: "POST",
      ...(body instanceof FormData
        ? { body }
        : body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return response.ok ? null : roomResponseError(response);
  } catch {
    return "Could not reach the server. Try again.";
  }
}

export async function fetchRoomHistory(participantId: string, cursor: string) {
  const response = await fetch(roomUrl("history", participantId, { cursor }));
  if (!response.ok) throw new Error(await roomResponseError(response));
  return decodeHistory(await response.json());
}
