import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
} from "@t3tools/client-runtime/state/command-output";
import {
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2GetTurnItemResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { TurnItemSource } from "~/components/chat/timelineRowContext";
import { roomUrl } from "./roomGuest.logic";

class RoomItemReadError extends Schema.TaggedError<RoomItemReadError>()("RoomItemReadError", {
  message: Schema.String,
}) {}

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));
const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2CommandOutputFrame),
);

const itemUrl = (route: string, participantId: string, itemId: string) =>
  roomUrl(route, participantId, { item: itemId });

/** `item` is null when the thread no longer has the item, or room access ended. */
async function fetchRoomItemDetail(
  participantId: string,
  itemId: string,
): Promise<OrchestrationV2GetTurnItemResult> {
  const response = await fetch(itemUrl("item", participantId, itemId));
  if (response.status === 403) return { item: null };
  if (!response.ok) throw new Error(`Room item request failed with ${response.status}.`);
  return decodeDetail(await response.json());
}

// Keys are JSON so a participant id or item id can never run into the next part.
const roomItemDetailAtom = Atom.family((key: string) => {
  const [participantId, itemId] = JSON.parse(key) as [string, string, string];
  return Atom.make(
    Effect.tryPromise({
      try: () => fetchRoomItemDetail(participantId, itemId),
      catch: () => new RoomItemReadError({ message: "Could not load this item." }),
    }),
  );
});

/** Ends after the frame of a settled command, so the browser does not reconnect to it. */
const roomCommandOutputAtom = Atom.family((key: string) => {
  const [participantId, itemId] = JSON.parse(key) as [string, string];
  const frames = Stream.callback<OrchestrationV2CommandOutputFrame, RoomItemReadError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource(itemUrl("command-output", participantId, itemId));
        source.addEventListener("message", (message) => {
          const frame = decodeFrame(message.data);
          if (Option.isNone(frame)) return;
          Queue.offerUnsafe(queue, frame.value);
          if (!frame.value.running) {
            source.close();
            Queue.endUnsafe(queue);
          }
        });
        // A non-200 response closes the source for good: room access ended or the item is gone.
        source.addEventListener("error", () => {
          if (source.readyState === EventSource.CLOSED) {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new RoomItemReadError({ message: "Output is no longer available." })),
            );
          }
        });
        return source;
      }),
      (source) => Effect.sync(() => source.close()),
    ),
  );
  // `scan` emits its seed first; skipping it keeps the row "loading" until the first frame.
  return Atom.make(
    frames.pipe(
      Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame),
      Stream.filter((view) => view !== EMPTY_COMMAND_OUTPUT),
    ),
  );
});

/** Expanded room rows use the participant-scoped cookie and HTTP routes. */
export const roomTurnItemSource = (participantId: string): TurnItemSource => ({
  detail: ({ itemId, revision }) =>
    roomItemDetailAtom(JSON.stringify([participantId, itemId, revision])),
  commandOutput: ({ itemId }) => roomCommandOutputAtom(JSON.stringify([participantId, itemId])),
});
