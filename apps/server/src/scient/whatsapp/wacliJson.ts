/**
 * `wacli --json` output read into Scient's WhatsApp schemas, and wacli's failures into
 * {@link WhatsAppToolError} codes. See docs/internals/scient-whatsapp.md.
 */
import {
  type WhatsAppChat,
  type WhatsAppChatKind,
  type WhatsAppContact,
  type WhatsAppMessage,
  WhatsAppToolError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// wacli prints the envelope on stdout on success and on stderr on failure, after any warnings.
const Envelope = Schema.fromJsonString(
  Schema.Struct({
    success: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export type WacliEnvelope = typeof Envelope.Type;
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

/** The last JSON envelope in a command's output. */
export function readEnvelope(output: string): WacliEnvelope | undefined {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    const envelope = decodeEnvelope(line);
    if (Option.isSome(envelope)) return envelope.value;
  }
  return undefined;
}

const Doctor = Schema.Struct({
  authenticated: Schema.Boolean,
  session_revoked: Schema.optional(Schema.Boolean),
  linked_jid: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WacliDoctor = typeof Doctor.Type;
const decodeDoctor = Schema.decodeUnknownOption(Doctor);
export const readDoctor = (data: unknown): WacliDoctor | undefined =>
  Option.getOrUndefined(decodeDoctor(data));

/** `972501234567:12@s.whatsapp.net` → `+972501234567`. */
export function accountFromJid(jid: string | null | undefined): string | undefined {
  const digits = /^(\d+)[:@]/u.exec(jid ?? "")?.[1];
  return digits === undefined ? undefined : `+${digits}`;
}

const Rows = Schema.NullOr(Schema.Array(Schema.Unknown));
const decodeRows = Schema.decodeUnknownOption(Rows);
const MessagesData = Schema.Struct({ messages: Rows });
const decodeMessagesData = Schema.decodeUnknownOption(MessagesData);

function mapRows<A>(
  rows: ReadonlyArray<unknown> | null | undefined,
  map: (row: unknown) => A | undefined,
): Array<A> {
  const out: Array<A> = [];
  for (const row of rows ?? []) {
    const mapped = map(row);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

const ChatRow = Schema.Struct({
  jid: Schema.String,
  kind: OptionalText,
  name: OptionalText,
  last_message_ts: OptionalText,
  archived: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
  unread_count: Schema.optional(Schema.Finite),
});
const decodeChatRow = Schema.decodeUnknownOption(ChatRow);

function chatKind(kind: string | null | undefined, jid: string): WhatsAppChatKind {
  switch (kind) {
    case "dm":
    case "group":
    case "broadcast":
      return kind;
    case "newsletter":
      return "channel";
  }
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) return "dm";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@newsletter")) return "channel";
  return "unknown";
}

// Go's zero time (`0001-01-01T00:00:00Z`) means "never".
function isoTimestamp(value: string | null | undefined): string | undefined {
  const time = value ? Option.getOrUndefined(DateTime.make(value)) : undefined;
  return time === undefined || DateTime.toEpochMillis(time) <= 0
    ? undefined
    : DateTime.formatIso(time);
}

export function readChats(data: unknown): Array<WhatsAppChat> {
  return mapRows(Option.getOrUndefined(decodeRows(data)), (row) => {
    const chat = Option.getOrUndefined(decodeChatRow(row));
    if (chat === undefined || chat.jid.trim() === "") return undefined;
    const lastMessageAt = isoTimestamp(chat.last_message_ts);
    return {
      jid: chat.jid,
      name: chat.name ?? "",
      kind: chatKind(chat.kind, chat.jid),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      unreadCount: chat.unread_count ?? 0,
      archived: chat.archived ?? false,
      pinned: chat.pinned ?? false,
    };
  });
}

const MessageRow = Schema.Struct({
  ChatJID: Schema.String,
  ChatName: OptionalText,
  MsgID: Schema.String,
  SenderJID: OptionalText,
  SenderName: OptionalText,
  FromMe: Schema.optional(Schema.Boolean),
  Timestamp: OptionalText,
  Text: OptionalText,
  DisplayText: OptionalText,
  MediaType: OptionalText,
  MediaCaption: OptionalText,
});
const decodeMessageRow = Schema.decodeUnknownOption(MessageRow);

const nonEmpty = (value: string | null | undefined) =>
  value === null || value === undefined || value === "" ? undefined : value;

/** `data.messages` of `messages list` and `messages search`. */
export function readMessages(data: unknown): Array<WhatsAppMessage> {
  const rows = Option.getOrUndefined(decodeMessagesData(data))?.messages;
  return mapRows(rows, (row) => {
    const message = Option.getOrUndefined(decodeMessageRow(row));
    if (message === undefined || message.MsgID.trim() === "" || message.ChatJID.trim() === "") {
      return undefined;
    }
    const chatName = nonEmpty(message.ChatName);
    const senderJid = nonEmpty(message.SenderJID);
    const senderName = nonEmpty(message.SenderName);
    const mediaType = nonEmpty(message.MediaType);
    return {
      id: message.MsgID,
      chatJid: message.ChatJID,
      ...(chatName === undefined ? {} : { chatName }),
      ...(senderJid === undefined ? {} : { senderJid }),
      ...(senderName === undefined ? {} : { senderName }),
      fromMe: message.FromMe ?? false,
      timestamp: isoTimestamp(message.Timestamp) ?? "",
      text:
        nonEmpty(message.Text) ??
        nonEmpty(message.DisplayText) ??
        nonEmpty(message.MediaCaption) ??
        "",
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  });
}

const ContactRow = Schema.Struct({
  jid: Schema.String,
  phone: OptionalText,
  name: OptionalText,
  alias: OptionalText,
  system_name: OptionalText,
});
const decodeContactRow = Schema.decodeUnknownOption(ContactRow);

export function readContacts(data: unknown): Array<WhatsAppContact> {
  return mapRows(Option.getOrUndefined(decodeRows(data)), (row) => {
    const contact = Option.getOrUndefined(decodeContactRow(row));
    if (contact === undefined || contact.jid.trim() === "") return undefined;
    const phone = nonEmpty(contact.phone);
    return {
      jid: contact.jid,
      name:
        nonEmpty(contact.alias) ?? nonEmpty(contact.system_name) ?? nonEmpty(contact.name) ?? "",
      ...(phone === undefined ? {} : { phone }),
    };
  });
}

const SendData = Schema.Struct({ id: Schema.String.check(Schema.isNonEmpty()), to: OptionalText });
const decodeSendData = Schema.decodeUnknownOption(SendData);
export const readSendResult = (data: unknown) => Option.getOrUndefined(decodeSendData(data));

const NOT_FOUND = /no local exact name match|no contacts, groups, or chats match|not found/iu;
const AMBIGUOUS = /ambiguous|matches \d+ recipients|multiple/iu;

/** A failed read, from wacli's error text. */
export function readFailure(error: string): WhatsAppToolError {
  if (AMBIGUOUS.test(error)) {
    return new WhatsAppToolError({
      code: "recipient-ambiguous",
      message: "More than one chat or contact matches that name. Use a phone number or JID.",
    });
  }
  if (NOT_FOUND.test(error)) {
    return new WhatsAppToolError({
      code: "recipient-not-found",
      message: "No chat or contact matches that name. Use a phone number or JID.",
    });
  }
  return new WhatsAppToolError({ code: "failed", message: "WhatsApp couldn't read the chats." });
}

export const sendUncertainError = () =>
  new WhatsAppToolError({
    code: "send-uncertain",
    message:
      "WhatsApp didn't confirm the message. It may still have been sent: check the chat before sending it again.",
  });

/** A failed send, from wacli's error text. */
export function sendFailure(error: string, to: string): WhatsAppToolError {
  if (/\b463\b/u.test(error)) {
    return new WhatsAppToolError({
      code: "first-message-from-phone",
      message: `WhatsApp only lets this account message ${to} after you send them a first message from your phone.`,
    });
  }
  if (/linked account itself/iu.test(error)) {
    return new WhatsAppToolError({
      code: "invalid-input",
      message: "Scient can't send WhatsApp messages to your own number.",
    });
  }
  // Before dispatch: another process holds the store, or nothing is connected.
  if (/store is locked|store lock|not connected|not authenticated/iu.test(error)) {
    return new WhatsAppToolError({
      code: "not-connected",
      message: "WhatsApp isn't connected right now. Try again in a minute.",
    });
  }
  if (/may still have gone through|uncertain|deadline exceeded|timed out|timeout/iu.test(error)) {
    return sendUncertainError();
  }
  if (AMBIGUOUS.test(error) || NOT_FOUND.test(error)) return readFailure(error);
  return new WhatsAppToolError({ code: "failed", message: "WhatsApp couldn't send the message." });
}
