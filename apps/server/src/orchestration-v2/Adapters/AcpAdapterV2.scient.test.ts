import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { scientAcpProviderBridge } from "./ScientAcpApplicationBridge.ts";

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The first text block of an outgoing `session/prompt`: the composed instructions and request. */
const outgoingPromptText = (event: EffectAcpProtocol.AcpProtocolLogEvent) => {
  if (event.direction !== "outgoing" || event.stage !== "raw" || typeof event.payload !== "string")
    return undefined;
  for (const line of event.payload.split("\n")) {
    const decoded = Option.getOrUndefined(decodeUnknownJson(line.trim()));
    if (typeof decoded !== "object" || decoded === null) continue;
    if (Reflect.get(decoded, "method") !== "session/prompt") continue;
    const prompt = Reflect.get(Reflect.get(decoded, "params") ?? {}, "prompt");
    const text = Array.isArray(prompt)
      ? prompt.find(
          (block) =>
            typeof block === "object" && block !== null && Reflect.get(block, "type") === "text",
        )
      : undefined;
    return text === undefined ? "" : String(Reflect.get(text, "text"));
  }
  return undefined;
};

const mockRuntime = (input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly protocolEvents: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
}): AcpAdapterV2Flavor["makeRuntime"] => {
  return (runtimeInput) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          protocolLogging: {
            ...runtimeInput.protocolLogging,
            logIncoming: true,
            logOutgoing: true,
            logger: (event) => Queue.offer(input.protocolEvents, event).pipe(Effect.asVoid),
          },
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: { T3_ACP_SESSION_LIFECYCLE: "1" },
          },
          authMethodId: "test",
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
};

describe("AcpAdapterV2 Scient awareness delivery", () => {
  it.live("re-sends prompt awareness when the session's grants change, and only then", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-awareness-transitions");
      const threadId = ThreadId.make("thread-acp-awareness-transitions");
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const grant = (capabilities: ReadonlyArray<string>) =>
        mcpSessions.set({
          environmentId: EnvironmentId.make("environment-acp-awareness-transitions"),
          threadId,
          providerSessionId: "mcp-session-acp-awareness-transitions",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer awareness-transition-token",
          capabilities: new Set(capabilities),
          connectors: [],
        });
      yield* grant(["accounts"]);
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ProviderDriverKind.make("acp-test"),
          capabilities: AcpProviderCapabilitiesV2,
          application: scientAcpProviderBridge,
          makeRuntime: mockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents }),
        },
        selfInvocation: yield* resolveSelfInvocation(),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-awareness-transitions"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const runTurn = Effect.fnUntraced(function* (ordinal: number, messageText: string) {
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal,
            messageText,
          }),
        );
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        while (true) {
          const prompt = outgoingPromptText(yield* Queue.take(protocolEvents));
          if (prompt !== undefined) return prompt;
        }
      });

      const first = yield* runTurn(0, "First request.");
      assert.include(first, "## Scient papers");
      assert.notInclude(first, "## Scient Compute");
      assert.notInclude(first, "## Scient browser");
      assert.equal(yield* runTurn(1, "Unchanged grants."), "Unchanged grants.");

      yield* grant(["accounts", "compute", "preview"]);
      const widened = yield* runTurn(2, "Wider grants.");
      assert.include(widened, "## Scient Compute");
      assert.include(widened, "## Scient browser");
      assert.include(widened, "Wider grants.");
      assert.equal(yield* runTurn(3, "Unchanged again."), "Unchanged again.");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
