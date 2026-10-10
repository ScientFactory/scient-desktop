import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CommandId } from "./baseSchemas.ts";
import {
  OrchestrationV2DispatchCommandError,
  ORCHESTRATION_V2_WS_METHODS,
} from "./orchestrationV2.ts";
import {
  WsConversationRpcGroup,
  WsDeviceAndTelemetryRpcGroup,
  WsRpcGroup,
  WsSubscribeServerConfigRpc,
} from "./rpc.ts";
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
  it("owns Thread Find registrations in the conversation group only", () => {
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.searchThread,
      ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
    ]) {
      expect(WsConversationRpcGroup.requests.has(method)).toBe(true);
      expect(WsDeviceAndTelemetryRpcGroup.requests.has(method)).toBe(false);
      expect(WsRpcGroup.requests.get(method)?.payloadSchema).toBe(
        WsConversationRpcGroup.requests.get(method)?.payloadSchema,
      );
    }
  });

  it("accepts retained section commands through the shared dispatch registration", () => {
    const command = {
      type: "thread.section.set",
      commandId: "section-command",
      threadId: "thread-1",
      sectionId: null,
    };
    expect(decodeDispatchPayload(command)).toEqual(command);
  });

  it("preserves durable native extraction refusal while ambiguous failures remain undecided", () => {
    for (const commandDisposition of [undefined, "rejected"] as const) {
      const error = new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("client:queue-extract:proof"),
        commandType: "queued-run.cancel",
        message: "Queue extraction failed",
        ...(commandDisposition === undefined ? {} : { commandDisposition }),
      });
      expect(decodeDispatchError(encodeDispatchError(error))).toMatchObject({
        commandId: error.commandId,
        commandType: error.commandType,
        ...(commandDisposition === undefined ? {} : { commandDisposition }),
      });
      const roundTrip = decodeDispatchError(encodeDispatchError(error));
      expect("commandDisposition" in roundTrip ? roundTrip.commandDisposition : undefined).toBe(
        commandDisposition,
      );
    }
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

  it("accepts native run forks and Scient message forks but refuses V1 turn commands", () => {
    for (const source of [
      { sourceAssistantMessageId: "assistant" },
      { sourceUserMessageId: "user" },
      { sourceRunningRunId: "running-run" },
    ]) {
      const command = {
        type: "thread.fork",
        commandId: "scient-fork",
        originThreadId: "origin",
        newThreadId: "destination",
        workspaceMode: "local",
        ...source,
      };
      expect(decodeDispatchPayload(command)).toEqual(command);
    }
    const runFork = {
      type: "thread.fork",
      commandId: "native-fork",
      sourceThreadId: "origin",
      targetThreadId: "destination",
      sourcePoint: { type: "run", runId: "run" },
      createdBy: "user",
      creationSource: "web",
    };
    expect(decodeDispatchPayload(runFork)).toEqual(runFork);
    expect(() =>
      decodeDispatchPayload({
        type: "thread.turn.start",
        commandId: "old-turn",
        threadId: "origin",
        message: { messageId: "message", role: "user", text: "Old command", attachments: [] },
        modelSelection: { instanceId: "codex", model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-10-04T00:00:00.000Z",
      }),
    ).toThrow();
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
