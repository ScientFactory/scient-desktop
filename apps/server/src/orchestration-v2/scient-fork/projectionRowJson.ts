/** Decoders for the JSON payload columns of V2 projection rows, shared by Scient's
 * in-transaction checks. */
import {
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const decodeTurnItemRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
export const decodeRunRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJson),
);
export const decodeMessageRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
