import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  ProjectId,
  MessageId,
} from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { GrokDriver } from "./GrokDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-managed-native-execution-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ProviderContinuationRequests.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "unused" }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000007")),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No external HTTP in native launch fixture")),
    ),
  ),
);

it.layer(testLayer)("Resolved driver native execution", (it) => {
  for (const mode of ["desktop", "web"] as const) {
    it.effect(`Codex uses the resolved ${mode} executable and its isolated environment`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const launches: Array<
            Parameters<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>[0]
          > = [];
          const instance = yield* CodexDriver.create({
            instanceId: ProviderInstanceId.make(`codex-native-${mode}`),
            displayName: undefined,
            enabled: false,
            environment: [
              { name: "PATH", value: root, sensitive: false },
              { name: "HOME", value: root, sensitive: false },
              { name: "SCIENT_TEST_INSTANCE", value: mode, sensitive: false },
            ],
            config: { ...CodexDriver.defaultConfig(), homePath: `${root}/codex-home` },
          }).pipe(
            Effect.provideService(ServerConfig.ServerConfig, { ...cfg, mode }),
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.provideService(HostProcessArchitecture, "arm64"),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("Synthetic missing CLI")),
            ),
            Effect.provideService(CodexAdapterV2.CodexAppServerClientFactory, {
              open: (input) =>
                Effect.sync(() => launches.push(input)).pipe(
                  Effect.andThen(Effect.die("Native launch captured")),
                ),
            }),
          );
          const threadId = ThreadId.make(`thread-${mode}`);
          yield* instance.orchestrationAdapter
            .openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(`session-${mode}`),
              configureMcp: false,
              modelSelection: { instanceId: instance.instanceId, model: "gpt-5.4" },
              runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: root,
              }),
            })
            .pipe(Effect.exit);
          assert.lengthOf(launches, 1);
          const launch = launches[0];
          if (!launch) return yield* Effect.die("Missing native launch");
          if (mode === "desktop")
            assert.include(launch.settings.binaryPath, `${cfg.baseDir}/provider-runtimes/codex/`);
          else assert.equal(launch.settings.binaryPath, "codex");
          assert.equal(launch.environment.SCIENT_TEST_INSTANCE, mode);
          assert.equal(launch.settings.homePath, `${root}/codex-home`);
          assert.equal(launch.environment.HOME, root);
        }),
      ),
    );
    it.effect(`Claude uses the resolved ${mode} SDK executable and managed update policy`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const launches: Array<
            Parameters<ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["open"]>[0]
          > = [];
          const instance = yield* ClaudeDriver.create({
            instanceId: ProviderInstanceId.make(`claude-native-${mode}`),
            displayName: undefined,
            enabled: false,
            environment: [
              { name: "PATH", value: root, sensitive: false },
              { name: "HOME", value: root, sensitive: false },
            ],
            config: { ...ClaudeDriver.defaultConfig(), homePath: `${root}/claude-config` },
          }).pipe(
            Effect.provideService(ServerConfig.ServerConfig, { ...cfg, mode }),
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.provideService(HostProcessArchitecture, "arm64"),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("Synthetic missing CLI")),
            ),
            Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
              allocateSessionId: Effect.succeed("00000000-0000-4000-8000-000000000012"),
              open: (input) =>
                Effect.sync(() => launches.push(input)).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                        method: "query",
                        cause: "Native launch captured",
                      }),
                    ),
                  ),
                ),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            }),
          );
          const threadId = ThreadId.make(`claude-thread-${mode}`);
          const modelSelection = { instanceId: instance.instanceId, model: "claude-sonnet-4-6" };
          const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: root,
          });
          const runtime = yield* instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(`claude-session-${mode}`),
            configureMcp: false,
            modelSelection,
            runtimePolicy,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const now = yield* DateTime.now;
          yield* runtime
            .startTurn({
              threadId,
              runId: RunId.make("run"),
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: RunAttemptId.make("attempt"),
              rootNodeId: NodeId.make("node"),
              providerThread,
              modelSelection,
              runtimePolicy,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make("message"),
                text: "Native query",
                attachments: [],
              },
              appThread: {
                createdBy: "user",
                creationSource: "web",
                id: threadId,
                projectId: ProjectId.make("project"),
                title: "Native launch",
                providerInstanceId: instance.instanceId,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                activeProviderThreadId: providerThread.id,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                deletedAt: null,
              },
            })
            .pipe(Effect.exit);
          assert.lengthOf(launches, 1);
          const launch = launches[0];
          if (!launch) return yield* Effect.die("Missing native query");
          if (mode === "desktop") {
            assert.include(
              launch.options.pathToClaudeCodeExecutable ?? "",
              `${cfg.baseDir}/provider-runtimes/claude/`,
            );
            assert.equal(launch.options.env?.DISABLE_UPDATES, "1");
          } else {
            assert.equal(launch.options.pathToClaudeCodeExecutable, "claude");
            assert.isUndefined(launch.options.env?.DISABLE_UPDATES);
          }
          assert.equal(launch.options.env?.CLAUDE_CONFIG_DIR, `${root}/claude-config`);
          assert.equal(launch.options.env?.HOME, root);
        }),
      ),
    );
    it.effect(`Grok uses the resolved ${mode} native ACP executable`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();
          const launches: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.sync(() => {
              if (ChildProcess.isStandardCommand(command))
                launches.push({ command: command.command, env: command.options.env ?? {} });
            }).pipe(Effect.andThen(Effect.die("Synthetic missing CLI"))),
          );
          const instance = yield* GrokDriver.create({
            instanceId: ProviderInstanceId.make(`grok-native-${mode}`),
            displayName: undefined,
            enabled: false,
            environment: [
              { name: "PATH", value: root, sensitive: false },
              { name: "HOME", value: root, sensitive: false },
              { name: "GROK_HOME", value: `${root}/grok-home`, sensitive: false },
            ],
            config: GrokDriver.defaultConfig(),
          }).pipe(
            Effect.provideService(ServerConfig.ServerConfig, { ...cfg, mode }),
            Effect.provideService(HostProcessPlatform, "darwin"),
            Effect.provideService(HostProcessArchitecture, "arm64"),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          launches.length = 0;
          yield* instance.orchestrationAdapter
            .openSession({
              threadId: ThreadId.make(`grok-thread-${mode}`),
              providerSessionId: ProviderSessionId.make(`grok-session-${mode}`),
              configureMcp: false,
              modelSelection: { instanceId: instance.instanceId, model: "grok-code-fast-1" },
              runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: root,
              }),
            })
            .pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.exit,
            );
          assert.lengthOf(launches, 1);
          const launch = launches[0];
          if (!launch) return yield* Effect.die("Missing native ACP launch");
          if (mode === "desktop")
            assert.include(launch.command, `${cfg.baseDir}/provider-runtimes/grok/`);
          else assert.equal(launch.command, "grok");
          assert.equal(launch.env.GROK_HOME, `${root}/grok-home`);
        }),
      ),
    );
  }
});
