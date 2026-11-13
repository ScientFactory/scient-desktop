import * as Schema from "effect/Schema";

import { GuestThreadModel } from "../guestStream.ts";
import { OrchestrationV2ThreadStreamItem } from "../orchestrationV2.ts";
import { RoomGuestView } from "./threadRoom.ts";

// This lives apart from threadRoom.ts because orchestrationV2.ts imports that file.

/**
 * The room as a guest's page gets it: `thread` carries the owner's thread stream items, starting
 * with a snapshot on every (re)connect; `view` is the room as this participant sees it, sent
 * first and again when it changes.
 */
export const RoomStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("view"),
    view: RoomGuestView,
    model: GuestThreadModel,
  }),
  Schema.Struct({ type: Schema.Literal("thread"), item: OrchestrationV2ThreadStreamItem }),
  Schema.Struct({
    type: Schema.Literal("ended"),
    reason: Schema.Literals(["closed", "removed", "expired", "archived"]),
  }),
]);
export type RoomStreamEvent = typeof RoomStreamEvent.Type;
