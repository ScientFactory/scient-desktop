import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, TurnId } from "./baseSchemas.ts";

/** Last successful answer, independent of the currently running turn. */
export const ScientCompletedAnswer = Schema.Struct({
  turnId: TurnId,
  messageId: MessageId,
  completedAt: IsoDateTime,
});
export type ScientCompletedAnswer = typeof ScientCompletedAnswer.Type;
