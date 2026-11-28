import type {
  WhatsAppChat,
  WhatsAppContact,
  WhatsAppError,
  WhatsAppMessage,
  WhatsAppSendResult,
  WhatsAppStatus,
  WhatsAppToolError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/**
 * The user's WhatsApp, linked as a device through Scient-managed `wacli`. One link per Scient
 * server; while linked, one supervised `wacli sync --follow` holds the WhatsApp connection and
 * every other command delegates to it. See docs/internals/scient-whatsapp.md.
 */
export class WhatsAppService extends Context.Service<
  WhatsAppService,
  {
    readonly status: Effect.Effect<WhatsAppStatus>;
    /** The current status first, then every change. */
    readonly changes: Stream.Stream<WhatsAppStatus>;
    /** Install if needed and start showing QR codes; a no-op while already linking or linked. */
    readonly startLink: Effect.Effect<WhatsAppStatus, WhatsAppError>;
    readonly cancelLink: Effect.Effect<WhatsAppStatus>;
    /** Log this device out of WhatsApp, stop the connection and delete the local store. */
    readonly unlink: Effect.Effect<WhatsAppStatus, WhatsAppError>;

    // Agent operations. Each fails with `not-linked`, `restricted` or `removed-by-phone` first.
    readonly listChats: (input: {
      readonly query?: string | undefined;
      readonly unreadOnly?: boolean | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<WhatsAppChat>, WhatsAppToolError>;
    /** Newest first. `chat` is a JID, a phone number or an exact chat name. */
    readonly listMessages: (input: {
      readonly chat: string;
      readonly limit: number;
      /** ISO 8601 or YYYY-MM-DD. */
      readonly before?: string | undefined;
      readonly after?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<WhatsAppMessage>, WhatsAppToolError>;
    readonly searchMessages: (input: {
      readonly query: string;
      readonly chat?: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<WhatsAppMessage>, WhatsAppToolError>;
    readonly searchContacts: (input: {
      readonly query: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<WhatsAppContact>, WhatsAppToolError>;
    /** One text message to one chat, paced by the running connection. Never a list of recipients. */
    readonly sendText: (input: {
      readonly to: string;
      readonly text: string;
      readonly replyTo?: string | undefined;
    }) => Effect.Effect<WhatsAppSendResult, WhatsAppToolError>;
  }
>()("t3/scient/whatsapp/WhatsAppService") {}
