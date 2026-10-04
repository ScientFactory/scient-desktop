import { ChatAttachment, MessageId, OrchestrationMessageContext } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A reserved inert history marker, not a native tool or provider instruction. */
export const HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME = "historical_system_message";
export const HistoricalSystemMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.NullOr(Schema.Array(ChatAttachment)),
  context: Schema.NullOr(OrchestrationMessageContext),
});
