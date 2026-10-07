import { OrchestrationV2DispatchCommandError, type CommandId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  OrchestratorCommandRejectedError,
  OrchestratorCommandPreviouslyRejectedError,
} from "./Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const isRejected = Schema.is(OrchestratorCommandRejectedError);
const isPreviouslyRejected = Schema.is(OrchestratorCommandPreviouslyRejectedError);

/** Only a durable refused command receipt permits a client to discard its extraction intent. */
export function dispatchCommandRpcError(
  command: { readonly commandId: CommandId; readonly type: string },
  cause: unknown,
) {
  const detail = userFacingDispatchErrorMessage(cause);
  const rejected =
    (isRejected(cause) || isPreviouslyRejected(cause)) &&
    cause.commandId === command.commandId &&
    cause.commandType === command.type;
  return new OrchestrationV2DispatchCommandError({
    commandId: command.commandId,
    commandType: command.type,
    message: detail ?? "Failed to dispatch orchestration V2 command",
    ...(detail === undefined ? {} : { detail }),
    ...(rejected ? { commandDisposition: "rejected" as const } : {}),
    cause,
  });
}
