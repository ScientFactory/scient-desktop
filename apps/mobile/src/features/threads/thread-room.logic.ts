import {
  ROOM_MESSAGE_MAX_ATTACHMENTS,
  ROOM_MESSAGE_MAX_ATTACHMENT_BYTES,
  ROOM_MESSAGE_MAX_LENGTH,
  type OrchestrationV2TurnItem,
  type RoomAuthor,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export type RoomMessageItem = Extract<OrchestrationV2TurnItem, { type: "room_message" }>;

export function roomAuthorLabel(author: RoomAuthor, resolve: MessageResolver = m): string {
  return author.kind === "owner"
    ? resolve(msg("You", { $context: "author of a room message" }))
    : author.name;
}

export function roomPostError(draft: {
  readonly text: string;
  readonly context?: { readonly records: ReadonlyArray<unknown> };
  readonly attachments: ReadonlyArray<{ readonly sizeBytes: number }>;
}): string | null {
  if (draft.context?.records.length)
    return m(msg("Added context only goes to the agent. Turn on Straight to agent, or remove it."));
  if (!draft.text.trim() && draft.attachments.length === 0) return m(msg("Add a message or file."));
  if (draft.text.trim().length > ROOM_MESSAGE_MAX_LENGTH)
    return m(
      msg("Room messages can contain at most {count} characters.", {
        count: ROOM_MESSAGE_MAX_LENGTH,
      }),
    );
  if (draft.attachments.length > ROOM_MESSAGE_MAX_ATTACHMENTS)
    return m(
      msg("Attach at most {count} files to a room message.", {
        count: ROOM_MESSAGE_MAX_ATTACHMENTS,
      }),
    );
  if (
    draft.attachments.reduce((size, attachment) => size + attachment.sizeBytes, 0) >
    ROOM_MESSAGE_MAX_ATTACHMENT_BYTES
  )
    return m(msg("These files are too large for a room message."));
  return null;
}
