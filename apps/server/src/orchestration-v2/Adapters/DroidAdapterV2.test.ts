// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DroidSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import { makeDroidAcpRuntime } from "../../provider/acp/DroidAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeDroidAdapterV2 } from "./DroidAdapterV2.ts";
const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-droid-v2-parity-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const mockAgentPath = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
);
const harness = Effect.fnUntraced(function* (
  locked = false,
  truncated = false,
  approveSpec = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const binary = NodePath.join(config.stateDir, "droid");
  const requestsPath = NodePath.join(
    config.stateDir,
    `requests-${yield* crypto.randomUUIDv4}.jsonl`,
  );
  yield* fs.writeFileString(
    binary,
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${mockAgentPath.replaceAll("'", "'\\''")}'\n`,
  );
  yield* fs.chmod(binary, 0o755);
  const instanceId = ProviderInstanceId.make("droid-v2-test");
  const threadId = ThreadId.make("droid-v2-thread");
  const modelSelection = { instanceId, model: "default" };
  const runtimePolicy = {
    cwd: config.stateDir,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const adapter = makeDroidAdapterV2({
    instanceId,
    settings: yield* decodeDroidSettings({ enabled: true, binaryPath: binary }),
    environment: {
      PATH: process.env.PATH,
      T3_ACP_DROID_AUTONOMY: "normal",
      T3_ACP_DROID_EMPTY_CONFIG_RESPONSE: "1",
      T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
      T3_ACP_REQUEST_LOG_PATH: requestsPath,
      ...(approveSpec
        ? { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_PERMISSION_TITLE: "Approve Spec" }
        : {}),
      ...(locked ? { T3_ACP_DROID_AUTONOMY_LOCKED: "1" } : {}),
    },
    sensitiveEnvironmentValues: [],
    makeRuntime: (input) =>
      makeDroidAcpRuntime(input).pipe(
        Effect.map((runtime) =>
          truncated
            ? {
                ...runtime,
                prompt: (request, dispatch) =>
                  runtime
                    .prompt(request, dispatch)
                    .pipe(Effect.as({ stopReason: "max_tokens" as const })),
              }
            : runtime,
        ),
      ),
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    crypto,
    fileSystem: fs,
    serverConfig: config,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    selfInvocation: yield* resolveSelfInvocation(),
    onAuthenticationRejected: () =>
      Effect.die("A fixture must never authenticate against a real account"),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("droid-v2-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("droid-v2-project"),
    title: "Droid parity",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(queue, event)),
    Effect.forkScoped,
  );
  const send = (
    ordinal: number,
    mode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
    interactionMode: "default" | "plan" = "default",
  ) =>
    runtime.startTurn({
      appThread,
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy: { ...runtimePolicy, runtimeMode: mode, interactionMode },
      runId: RunId.make(`droid-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`droid-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`droid-root-${ordinal}`),
      message: {
        messageId: MessageId.make(`droid-message-${ordinal}`),
        text: "Say hello",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
  const terminal = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      recorded.push(event);
      if (event.type === "turn.terminal") return event;
    }
  });
  const recorded: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const approval = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      recorded.push(event);
      if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending")
        return event.runtimeRequest;
      if (event.type === "turn.terminal")
        return yield* Effect.die("The specification was approved without user permission");
    }
  });
  const requests = () =>
    NodeFS.readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => decodeRequest(line));
  return { send, terminal, requests, recorded, approval, runtime };
});

it.layer(testLayer, { excludeTestServices: true })("DroidAdapterV2", (it) => {
  it.effect("requires explicit specification approval in full access", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, true);
        yield* h.send(1, "full-access");
        const request = yield* h.approval;
        assert.equal(request.status, "pending");
        yield* h.runtime.respondToRuntimeRequest({ requestId: request.id, decision: "accept" });
        assert.equal((yield* h.terminal).status, "completed");
      }),
    ),
  );
  it.effect("keeps token-budget truncation successful and persists its notice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, true);
        yield* h.send(1, "approval-required");
        assert.equal((yield* h.terminal).status, "completed");
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "notification" &&
              event.turnItem.source.kind === "output_truncated" &&
              event.turnItem.source.stopReason === "max_tokens",
          ),
        );
      }),
    ),
  );
  it.effect("confirms native autonomy on consecutive mode changes and plan entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        for (const [ordinal, mode, interaction] of [
          [1, "full-access", "default"],
          [2, "approval-required", "default"],
          [3, "full-access", "plan"],
        ] as const) {
          yield* h.send(ordinal, mode, interaction);
          assert.equal((yield* h.terminal).status, "completed");
        }
        const writes = h
          .requests()
          .filter(
            (request) =>
              request.method === "session/set_config_option" &&
              request.params?.configId === "autonomy_level",
          );
        assert.deepEqual(
          writes.map((request) => request.params?.value),
          ["auto-high", "normal", "spec"],
        );
        assert.equal(
          h.requests().filter((request) => request.method === "session/prompt").length,
          3,
        );
        assert.isFalse(h.requests().some((request) => request.method === "session/set_mode"));
      }),
    ),
  );
  it.effect("refuses delivery when Droid acknowledges an autonomy write without applying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(true);
        const result = yield* Effect.result(h.send(1, "full-access"));
        assert.equal(result._tag, "Failure");
        assert.isFalse(h.requests().some((request) => request.method === "session/prompt"));
      }),
    ),
  );
});
