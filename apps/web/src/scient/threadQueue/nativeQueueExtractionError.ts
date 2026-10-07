import {
  OrchestrationV2DispatchCommandError,
  ScientThreadQueueOperationError,
  type CommandId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isDispatchError = Schema.is(OrchestrationV2DispatchCommandError);

/** Ambiguous errors retain the same extraction token and its journaled bytes. */
export function nativeQueueExtractionError(cause: unknown, commandId: CommandId): unknown {
  return isDispatchError(cause) &&
    cause.commandId === commandId &&
    cause.commandType === "queued-run.cancel" &&
    cause.commandDisposition === "rejected"
    ? new ScientThreadQueueOperationError({ message: cause.message })
    : cause;
}
