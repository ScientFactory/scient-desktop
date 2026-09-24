import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";
import type { OmpRpcProcess } from "../provider/omp/OmpRpcProcess.ts";

const response = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "text-request",
  type: "response",
  command,
  success: true,
  data,
});

const makeClient = (events: ReadonlyArray<OmpRpcNotification>) =>
  ({
    version: "18.2.8",
    binaryPathFingerprint: "binary-test",
    ready: Effect.succeed({
      type: "ready" as const,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    }),
    events: Stream.fromIterable(events),
    flushEvents: () => Effect.void,
    command: () => Effect.succeed(response("command")),
    prompt: () => Effect.succeed(response("prompt", { agentInvoked: true })),
    steer: () => Effect.succeed(response("steer")),
    followUp: () => Effect.succeed(response("follow_up")),
    abort: () => Effect.succeed(response("abort")),
    getState: () => Effect.succeed({ isStreaming: false, isCompacting: false }),
    getModels: () => Effect.succeed({ models: [] }),
    getCommands: () => Effect.succeed({ commands: [] }),
    setModel: () => Effect.succeed(response("set_model")),
    setThinkingLevel: () => Effect.succeed(response("set_thinking_level")),
    compact: () => Effect.succeed(response("compact")),
    switchSession: () => Effect.succeed({ cancelled: false }),
    setSubagentSubscription: () => Effect.succeed(response("set_subagent_subscription")),
    setHostTools: () => Effect.succeed(response("set_host_tools")),
    setHostUriSchemes: () => Effect.succeed(response("set_host_uri_schemes")),
    extensionUiResponse: () => Effect.void,
    hostToolUpdate: () => Effect.void,
    hostToolResult: () => Effect.void,
    hostUriResult: () => Effect.void,
    close: () => Effect.void,
    shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
  }) satisfies OmpRpcProcess;

const settings = Schema.decodeSync(
  Schema.Struct({
    enabled: Schema.Boolean,
    binaryPath: Schema.String,
    homePath: Schema.String,
    profile: Schema.String,
  }),
)({ enabled: true, binaryPath: "omp", homePath: "", profile: "" });

const modelSelection = createModelSelection(ProviderInstanceId.make("omp"), "anthropic/test-model");

describe("Oh My Pi text generation", () => {
  it.effect("reconciles a complete assistant message when deltas are absent", () =>
    Effect.gen(function* () {
      const service = yield* makeOmpTextGeneration(settings, {}, () =>
        Effect.succeed(
          makeClient([
            {
              _tag: "Event",
              event: {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: '{"title":"Fallback title","needsRefinement":false}',
                },
              },
            },
            { _tag: "Event", event: { type: "agent_end", messages: [], isTerminal: true } },
          ]),
        ),
      );
      const result = yield* service.generateThreadTitle({
        cwd: process.cwd(),
        message: "Summarize this work",
        modelSelection,
      });
      expect(result.title).toBe("Fallback title");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("settles a later local prompt_result instead of waiting for agent_end", () =>
    Effect.gen(function* () {
      const service = yield* makeOmpTextGeneration(settings, {}, () =>
        Effect.succeed(
          makeClient([{ _tag: "Event", event: { type: "prompt_result", agentInvoked: false } }]),
        ),
      );
      const result = yield* service
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "This should be local only",
          modelSelection,
        })
        .pipe(Effect.flip);
      expect(result.message).toContain("without a model response");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
