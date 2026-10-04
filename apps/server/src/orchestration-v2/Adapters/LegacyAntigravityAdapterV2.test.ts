// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AntigravitySettings,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeLegacyAntigravityAdapterV2 } from "./LegacyAntigravityAdapterV2.ts";

const decodeSettings = Schema.decodeEffect(AntigravitySettings);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-agy-v2-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

it.layer(TestLayer, { excludeTestServices: true })("LegacyAntigravityAdapterV2", (it) => {
  it.effect(
    "retains resume policy and observes replacement-process failure through real native events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const binary = path.join(config.stateDir, "agy");
          const argumentsPath = path.join(config.stateDir, "launch-arguments.txt");
          const pidPath = path.join(config.stateDir, "child-pids.txt");
          const mockPath = NodeURL.fileURLToPath(
            new URL("../../../scripts/agy-stream-mock.ts", import.meta.url),
          );
          yield* fs.writeFileString(
            binary,
            `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(argumentsPath)}\nprintf '%s\\n' "$$" >> ${quote(pidPath)}\nexec ${quote(process.execPath)} ${quote(mockPath)} "$@"\n`,
          );
          yield* fs.chmod(binary, 0o755);
          const instanceId = ProviderInstanceId.make("agy-v2-test");
          const threadId = ThreadId.make("agy-v2-thread");
          const modelSelection = {
            instanceId,
            model: "mock-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          };
          const runtimePolicy = {
            cwd: config.stateDir,
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
          };
          const adapter = makeLegacyAntigravityAdapterV2({
            instanceId,
            settings: yield* decodeSettings({ enabled: true, binaryPath: binary }),
            environment: {},
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            fileSystem: fs,
            path,
            serverConfig: config,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            continuations: {
              offer: () => Effect.die("An idle process failure must not wake a synthetic turn"),
            },
          });
          assert.isFalse(adapter.mcpSessionInjection);
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("agy-v2-session"),
            modelSelection,
            runtimePolicy,
          });
          const initialThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          assert.isNull(initialThread.nativeThreadRef);
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* runtime.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const takeUntil = (
            predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
          ) =>
            Effect.gen(function* () {
              while (true) {
                const event = yield* Queue.take(events);
                if (predicate(event)) return event;
              }
            });
          const now = yield* DateTime.now;
          const appThread: OrchestrationV2AppThread = {
            id: threadId,
            projectId: ProjectId.make("agy-v2-project"),
            title: "Antigravity parity",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
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
          const start = (ordinal: number, providerThread: typeof initialThread) =>
            runtime.startTurn({
              appThread,
              threadId,
              providerThread,
              modelSelection,
              runtimePolicy,
              runId: RunId.make(`agy-run-${ordinal}`),
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              attemptId: RunAttemptId.make(`agy-attempt-${ordinal}`),
              rootNodeId: NodeId.make(`agy-root-${ordinal}`),
              message: {
                messageId: MessageId.make(`agy-message-${ordinal}`),
                text: "TOOL",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
          yield* start(1, initialThread);
          const first = yield* takeUntil(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeThreadRef !== null,
          );
          if (first.type !== "provider_thread.updated")
            return yield* Effect.die("Missing native thread receipt");
          assert.equal(first.providerThread.nativeThreadRef?.strength, "strong");
          yield* takeUntil(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          );
          const resumed = yield* runtime.resumeThread({
            providerThread: {
              ...first.providerThread,
              nativeThreadRef: {
                driver: runtime.driver,
                nativeId: "resumed-conversation",
                strength: "strong",
              },
            },
          });
          yield* start(2, resumed);
          const second = yield* takeUntil((event) => event.type === "turn.terminal");
          if (second.type === "turn.terminal") assert.equal(second.status, "completed");
          const args = (yield* fs.readFileString(argumentsPath)).trim().split("\n");
          assert.equal(args.filter((value) => value === "--effort").length, 2);
          assert.equal(args.filter((value) => value === "high").length, 2);
          assert.include(args, "resumed-conversation");
          const pids = (yield* fs.readFileString(pidPath)).trim().split("\n").map(Number);
          assert.equal(pids.length, 2);
          const replacementPid = pids[1];
          if (!replacementPid || !Number.isSafeInteger(replacementPid))
            return yield* Effect.die("Invalid fixture child PID");
          // The PID was recorded by this test's private wrapper before exec, never by a process search.
          yield* Effect.sync(() => process.kill(replacementPid, "SIGTERM"));
          yield* takeUntil(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          );
          assert.equal(runtime.providerSession.status, "error");
        }),
      ),
  );
});
