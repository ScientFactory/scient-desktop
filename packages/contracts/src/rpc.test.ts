import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";
import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";

const sharedDispatchRpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
if (!sharedDispatchRpc) throw new Error("dispatchCommand is not registered");
const decodeDispatchPayload = Schema.decodeUnknownSync(sharedDispatchRpc.payloadSchema);
const encodeDispatchError = Schema.encodeSync(sharedDispatchRpc.errorSchema);
const decodeDispatchError = Schema.decodeUnknownSync(sharedDispatchRpc.errorSchema);
const decodeServerConfigPayload = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema);

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = decodeServerConfigPayload({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = decodeServerConfigPayload({});
    expect(decoded).toEqual({});
  });
});

describe("WebSocket RPC contracts", () => {
  it("accepts retained section commands through the shared dispatch registration", () => {
    const command = {
      type: "thread.section.set",
      commandId: "section-command",
      threadId: "thread-1",
      sectionId: null,
    };
    expect(decodeDispatchPayload(command)).toEqual(command);
  });

  it("preserves every fork disposition through the registered error codec", () => {
    for (const forkDisposition of ["rejected", "abandoned", "ready"] as const) {
      const error = new OrchestrationDispatchCommandError({
        message: "Fork failed",
        forkDisposition,
      });
      const encoded = encodeDispatchError(error);
      expect(encoded).toMatchObject({ forkDisposition });
      expect(decodeDispatchError(encoded)).toMatchObject({ forkDisposition });
    }
  });
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
});
