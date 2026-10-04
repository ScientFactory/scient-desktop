import {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A reserved inert history marker, not a native tool or provider instruction. */
export const HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME = "historical_system_message";
export const HistoricalSystemMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.NullOr(Schema.Array(ChatAttachment)),
  context: Schema.NullOr(OrchestrationMessageContext),
});

const decodeText = Schema.decodeUnknownOption(
  Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.optional(Schema.Unknown),
    context: Schema.optional(Schema.Unknown),
  }),
);
const decodeAttachments = Schema.decodeUnknownOption(HistoricalSystemMessage.fields.attachments);
const decodeContext = Schema.decodeUnknownOption(HistoricalSystemMessage.fields.context);

/** Only inert migration provenance grants system-history interpretation or file copying. */
export function readHistoricalSystemMessage(item: OrchestrationV2TurnItem) {
  if (
    item.type !== "dynamic_tool" ||
    item.toolName !== HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME ||
    item.runId !== null ||
    item.nodeId !== null ||
    item.nativeItemRef !== null ||
    item.providerThreadId !== null ||
    item.providerTurnId !== null ||
    !(item.inheritedFrom?.itemId ?? item.id).startsWith("migration:v1:history:system:")
  )
    return Option.none<typeof HistoricalSystemMessage.Type>();
  return Option.map(decodeText(item.input), (record) => ({
    messageId: record.messageId,
    text: record.text,
    attachments: Option.getOrElse(decodeAttachments(record.attachments), () => null),
    context: Option.getOrElse(decodeContext(record.context), () => null),
  }));
}
