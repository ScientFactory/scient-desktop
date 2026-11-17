import {
  FEEDBACK_CONVERSATION_MAX_BYTES,
  FEEDBACK_EMAIL_MAX_LENGTH,
  FEEDBACK_LOGS_MAX_BYTES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FeedbackAppDetails,
  FeedbackErrorContext,
  FeedbackScreen,
  FeedbackSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../../ipc/channels.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import type { DesktopFeedback } from "./DesktopFeedback.ts";

const SubmitRequest = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(FEEDBACK_MESSAGE_MAX_LENGTH)),
  source: FeedbackSource,
  screen: FeedbackScreen,
  contactEmail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(FEEDBACK_EMAIL_MAX_LENGTH))),
  details: FeedbackAppDetails,
  error: Schema.NullOr(FeedbackErrorContext),
  screenshot: Schema.NullOr(Schema.Uint8Array),
  // Characters bound the IPC payload; the service checks the encoded byte limits.
  logs: Schema.NullOr(Schema.String.check(Schema.isMaxLength(FEEDBACK_LOGS_MAX_BYTES))),
  conversation: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(FEEDBACK_CONVERSATION_MAX_BYTES)),
  ),
});

const methods = (feedback: DesktopFeedback["Service"]) => [
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.FEEDBACK_PREPARE_CHANNEL,
    payload: Schema.Void,
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.feedback.prepare")(function* () {
      return yield* feedback.prepare;
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.FEEDBACK_CAPTURE_SCREENSHOT_CHANNEL,
    payload: Schema.Void,
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.feedback.captureScreenshot")(function* (_input, event) {
      if (event === undefined) return null;
      return yield* feedback.captureScreenshot(event.sender.id);
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.FEEDBACK_READ_RECENT_LOGS_CHANNEL,
    payload: Schema.Void,
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.feedback.readRecentLogs")(function* () {
      return yield* feedback.readRecentLogs;
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.FEEDBACK_SUBMIT_CHANNEL,
    payload: SubmitRequest,
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.feedback.submit")(function* (request) {
      return yield* feedback.submit(request);
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.FEEDBACK_TAKE_FIXED_NOTICES_CHANNEL,
    payload: Schema.Void,
    result: Schema.Unknown,
    handler: Effect.fn("desktop.ipc.feedback.takeFixedNotices")(function* () {
      return yield* feedback.takeFixedNotices;
    }),
  }),
];

export const installFeedbackIpc = Effect.fn("DesktopFeedback.installIpc")(function* (
  feedback: DesktopFeedback["Service"],
) {
  const ipc = yield* DesktopIpc.DesktopIpc;
  for (const method of methods(feedback)) yield* ipc.handle(method);
});
