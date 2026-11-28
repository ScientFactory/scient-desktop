import { type WhatsAppStatus, WhatsAppToolError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { WhatsAppService } from "../../../scient/whatsapp/WhatsAppService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LIMITS, WhatsAppToolkit, type WhatsAppToolStatus } from "./tools.ts";

const LINK_IN_SETTINGS =
  "Ask the user to link WhatsApp in Settings → Extensions → WhatsApp; never try to link it yourself.";

/** Never returns the QR code: only the user's phone may scan it. */
export function summarizeStatus({ state, platformSupported }: WhatsAppStatus): WhatsAppToolStatus {
  switch (state._tag) {
    case "Unlinked":
      return {
        linked: false,
        state: "unlinked",
        next: platformSupported
          ? `WhatsApp is not linked. ${LINK_IN_SETTINGS}`
          : "Scient cannot link WhatsApp on this computer.",
      };
    case "Installing":
    case "AwaitingScan":
    case "Syncing":
      return {
        linked: false,
        state: (
          { Installing: "installing", AwaitingScan: "awaiting-scan", Syncing: "syncing" } as const
        )[state._tag],
        next: "The user is linking WhatsApp now. Try again in a minute.",
      };
    case "Linked":
      return {
        linked: true,
        state: "linked",
        account: state.account,
        connection: state.connection,
        ...(state.connection === "connected"
          ? {}
          : {
              next: "Linked but not connected right now: reads may be out of date and sends fail until it reconnects.",
            }),
      };
    case "Restricted":
      return {
        linked: true,
        state: "restricted",
        ...(state.account === undefined ? {} : { account: state.account }),
        ...(state.until === undefined
          ? {}
          : { restrictedUntil: DateTime.formatIso(DateTime.makeUnsafe(state.until)) }),
        next: "WhatsApp temporarily restricted this account. Do not use WhatsApp until the restriction ends.",
      };
    case "RemovedByPhone":
      return {
        linked: false,
        state: "removed-by-phone",
        next: `The phone removed Scient's link. ${LINK_IN_SETTINGS}`,
      };
    case "Failed":
      return {
        linked: false,
        state: "failed",
        next: `Linking failed: ${state.message} ${LINK_IN_SETTINGS}`,
      };
  }
}

const clamp = (
  limit: number | undefined,
  { fallback, maximum }: (typeof LIMITS)[keyof typeof LIMITS],
) => Math.min(limit ?? fallback, maximum);

// An MCP tool error carries only the message; the descriptions tell agents what to do per code.
const withCode = (error: WhatsAppToolError) =>
  new WhatsAppToolError({ code: error.code, message: `${error.code}: ${error.message}` });

const requireWhatsApp = McpInvocationContext.requireMcpCapability("whatsapp").pipe(
  Effect.andThen(WhatsAppService),
);

export const layer = McpToolAccess.toLayer(WhatsAppToolkit, {
  whatsapp_status: McpToolAccess.reads(() =>
    requireWhatsApp.pipe(
      Effect.flatMap((whatsapp) => whatsapp.status),
      Effect.map(summarizeStatus),
    ),
  ),
  whatsapp_chats: McpToolAccess.reads(({ query, unreadOnly, limit }) =>
    requireWhatsApp.pipe(
      Effect.flatMap((whatsapp) =>
        whatsapp
          .listChats({ query, unreadOnly, limit: clamp(limit, LIMITS.chats) })
          .pipe(Effect.mapError(withCode)),
      ),
      Effect.map((chats) => ({ chats })),
    ),
  ),
  whatsapp_messages: McpToolAccess.reads(({ limit, ...input }) =>
    requireWhatsApp.pipe(
      Effect.flatMap((whatsapp) =>
        whatsapp
          .listMessages({ ...input, limit: clamp(limit, LIMITS.messages) })
          .pipe(Effect.mapError(withCode)),
      ),
      Effect.map((messages) => ({ messages })),
    ),
  ),
  whatsapp_search: McpToolAccess.reads(({ limit, ...input }) =>
    requireWhatsApp.pipe(
      Effect.flatMap((whatsapp) =>
        whatsapp
          .searchMessages({ ...input, limit: clamp(limit, LIMITS.search) })
          .pipe(Effect.mapError(withCode)),
      ),
      Effect.map((messages) => ({ messages })),
    ),
  ),
  whatsapp_contacts: McpToolAccess.reads(({ query, limit }) =>
    requireWhatsApp.pipe(
      Effect.flatMap((whatsapp) =>
        whatsapp
          .searchContacts({ query, limit: clamp(limit, LIMITS.contacts) })
          .pipe(Effect.mapError(withCode)),
      ),
      Effect.map((contacts) => ({ contacts })),
    ),
  ),
  whatsapp_send: McpToolAccess.writesWithCapability((input) =>
    requireWhatsApp.pipe(
      Effect.flatMap((whatsapp) => whatsapp.sendText(input).pipe(Effect.mapError(withCode))),
    ),
  ),
});
