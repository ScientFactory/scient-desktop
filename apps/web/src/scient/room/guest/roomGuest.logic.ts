import {
  ROOM_PAGE_PARAM,
  ROOM_PARTICIPANT_PARAM,
  ROOM_ROUTE_PREFIX,
  RoomStreamEvent,
  type GuestThreadModel,
  type OrchestrationV2ProjectedTurnItem,
  type RoomGuestView,
  type RoomRole,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import {
  applyGuestStreamEvent,
  initialGuestStreamState,
  type GuestHistoryPageLoaded,
} from "~/components/guest/guestStream.logic";

export function readRoomEntry(search: string, hash: string) {
  let credential: string | null = null;
  try {
    credential = decodeURIComponent(hash.slice(1)).trim() || null;
  } catch {}
  return {
    credential,
    participantId: new URLSearchParams(search).get(ROOM_PAGE_PARAM) || null,
  };
}

export const roomUrl = (path: string, participantId: string, params: Record<string, string> = {}) =>
  `${ROOM_ROUTE_PREFIX}/${path}?${new URLSearchParams({ [ROOM_PARTICIPANT_PARAM]: participantId, ...params })}`;

export const roomAttachmentUrl = (participantId: string, itemId: string, attachmentId: string) =>
  roomUrl("attachment", participantId, { item: itemId, id: attachmentId });

export function createRoomAttachmentUrls(participantId: string) {
  let previousItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> | null = null;
  let previous: ReadonlyMap<string, string> = new Map();
  return (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) => {
    if (items === previousItems) return previous;
    previousItems = items;
    previous = new Map(
      items.flatMap(({ item }) =>
        item.type === "user_message" || item.type === "room_message"
          ? (item.attachments ?? []).map(
              (attachment) =>
                [attachment.id, roomAttachmentUrl(participantId, item.id, attachment.id)] as const,
            )
          : [],
      ),
    );
    return previous;
  };
}

type EndReason = Extract<RoomStreamEvent, { type: "ended" }>["reason"];
export interface RoomStreamState {
  readonly view: RoomGuestView | null;
  readonly model: GuestThreadModel | null;
  readonly thread: typeof initialGuestStreamState;
  readonly ended: EndReason | null;
}

export const initialRoomStreamState: RoomStreamState = {
  view: null,
  model: null,
  thread: initialGuestStreamState,
  ended: null,
};

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(RoomStreamEvent)),
);
export const parseRoomStreamEvent = (data: string) => Option.getOrNull(decodeEvent(data));

export function applyRoomStreamEvent(
  state: RoomStreamState,
  event: RoomStreamEvent | GuestHistoryPageLoaded,
): RoomStreamState {
  if (state.ended !== null) return state;
  switch (event.type) {
    case "view":
      return { ...state, view: event.view, model: event.model };
    case "ended":
      return { ...state, ended: event.reason };
    case "thread":
    case "history-page":
      return { ...state, thread: applyGuestStreamEvent(state.thread, event) };
  }
}

/** `msg()` strings: resolve them where they show. */
export const roomEndedNotice: Record<EndReason, string> = {
  closed: msg("The owner closed this room."),
  removed: msg("Your access to this room was removed."),
  expired: msg("Your access to this room has expired."),
  archived: msg("This thread was archived. The room has ended."),
};

const ROOM_ROLE_LABELS: Record<RoomRole, string> = {
  watch: msg("Can view"),
  discuss: msg("Can chat"),
  agent: msg("Can use agent"),
};

/** What a person in the room may do, in the UI language. */
export function roomRoleLabel(role: RoomRole, resolve: MessageResolver = m): string {
  return resolve(ROOM_ROLE_LABELS[role]);
}

export function formatRoomExpiry(expiresAt: string, nowMs: number, resolve: MessageResolver = m) {
  const minutes = Math.floor((Date.parse(expiresAt) - nowMs) / 60_000);
  if (minutes <= 0) return resolve(msg("Expired", { $context: "the room link has expired" }));
  if (minutes >= 1440) {
    return resolve(msg("{days}d left", { days: Math.floor(minutes / 1440) }));
  }
  return minutes >= 60
    ? resolve(msg("{hours}h left", { hours: Math.floor(minutes / 60) }))
    : resolve(msg("{minutes}m left", { minutes }));
}
