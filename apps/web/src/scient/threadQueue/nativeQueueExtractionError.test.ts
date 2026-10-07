import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  ScientThreadQueueOperationError,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { nativeQueueExtractionError } from "./nativeQueueExtractionError";

const rpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
if (!rpc) throw new Error("Missing registered dispatch RPC");
const encodeError = Schema.encodeSync(rpc.errorSchema);
const decodeError = Schema.decodeSync(rpc.errorSchema);
const commandId = CommandId.make("client:queue-extract:proof");
const wire = (error: OrchestrationV2DispatchCommandError) => decodeError(encodeError(error));

it("recognizes only exact-owner durable cancellation rejection from the registered RPC codec", () => {
  const error = wire(
    new OrchestrationV2DispatchCommandError({
      commandId,
      commandType: "queued-run.cancel",
      message: "Already delivered",
      commandDisposition: "rejected",
    }),
  );
  expect(nativeQueueExtractionError(error, commandId)).toBeInstanceOf(
    ScientThreadQueueOperationError,
  );
  expect(nativeQueueExtractionError(error, CommandId.make("other-token"))).toBe(error);
  const wrongType = wire(
    new OrchestrationV2DispatchCommandError({
      commandId,
      commandType: "queued-run.edit",
      message: "Edit rejected",
      commandDisposition: "rejected",
    }),
  );
  expect(nativeQueueExtractionError(wrongType, commandId)).toBe(wrongType);
});

it("preserves undecided RPC/transport failures for same-token journal recovery", () => {
  const error = wire(
    new OrchestrationV2DispatchCommandError({
      commandId,
      commandType: "queued-run.cancel",
      message: "Receipt storage unavailable",
    }),
  );
  expect(nativeQueueExtractionError(error, commandId)).toBe(error);
  const transport = new Error("Connection lost after commit");
  expect(nativeQueueExtractionError(transport, commandId)).toBe(transport);
});
