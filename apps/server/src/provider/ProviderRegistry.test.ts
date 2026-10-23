import * as PlatformError from "effect/PlatformError";
import { makeProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { ClaudeDriver } from "./Drivers/ClaudeDriver.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import { scientAntigravityInstallationLayer } from "../scient/providerLifecycle/ScientAntigravityInstallation.ts";
import * as OmpExecutableGate from "./omp/OmpExecutableGate.ts";
import { PtyAdapter } from "@t3tools/shared/PtyAdapter";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert, expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { deepMerge } from "@t3tools/shared/Struct";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLifecycleCoordinator from "../scient/providerLifecycle/ProviderLifecycleCoordinator.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
// SCIENT-FORK: the shared driver error moved with the driver SPI.
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeServerProvider = Schema.decodeSync(ServerProvider);
const encodeServerProvider = Schema.encodeSync(ServerProvider);
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

const disabledDefaultSlots = (
  ...drivers: ReadonlyArray<string>
): ContractServerSettings["providerInstances"] =>
  Object.fromEntries(
    drivers.map((driver) => [
      ProviderInstanceId.make(driver),
      { driver: ProviderDriverKind.make(driver), enabled: false },
    ]),
  );

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});

process.env.T3CODE_CURSOR_ENABLED = "1";

const encoder = new TextEncoder();
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const withBundledCompatibility = (snapshot: ServerProvider) =>
  applyProviderCompatibility(
    snapshot,
    undefined,
    ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
  );

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
).pipe(Layer.provideMerge(ModelManifest.layerTest));

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiKeySource: undefined,
      apiProvider: undefined,
      slashCommands: [],
      ...overrides,
    });
}

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      ...ServerSettingsModule.customModelsTestMethods,
      committedCustomModels: () => Ref.getUnsafe(settingsRef).customModels,
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      updateProviderInstance: (mutation, patch = {}) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = ServerSettingsModule.applyProviderInstanceMutation(
            applyServerSettingsPatch(current, patch),
            mutation,
          );
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      withSettingsSnapshot: (use) => Ref.get(settingsRef).pipe(Effect.flatMap(use)),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}

// Registry publication precedes cache I/O. Observe the real atomic rename and
// decoded cache contents, rather than treating an in-memory event as durability.
function makeProviderCacheWriteObserver() {
  const pending = new Map<
    string,
    { readonly checkedAt: string; readonly completion: Deferred.Deferred<void> }
  >();
  const layer = Layer.updateService(FileSystem.FileSystem, (fs) => ({
    ...fs,
    rename: (from, to) =>
      fs.rename(from, to).pipe(
        Effect.tap(() => {
          const expected = pending.get(to);
          if (expected === undefined) return Effect.void;
          return readProviderStatusCache(to).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.flatMap((provider) =>
              provider?.checkedAt === expected.checkedAt
                ? Deferred.succeed(expected.completion, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          );
        }),
      ),
  }));
  const awaitPersisted = (filePath: string, checkedAt: string) =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<void>();
      pending.set(filePath, { checkedAt, completion });
      const cached = yield* readProviderStatusCache(filePath);
      if (cached?.checkedAt === checkedAt) yield* Deferred.succeed(completion, undefined);
      return yield* Deferred.await(completion).pipe(Effect.forkScoped);
    });
  return { layer, awaitPersisted };
}

const layerTestNodeServices = Layer.mergeAll(
  ProviderLatestVersions.layer,
  NodeServices.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({
    managedDirectory: "unused-managed-installation",
  }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
);

function layerMockCommandSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

const disabledCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({
  enabled: false,
});

function layerFailingSpawner(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        args: ReadonlyArray<string>;
        options?: {
          readonly env?: NodeJS.ProcessEnv;
        };
      };
      commands.push({ args: cmd.args, env: cmd.options?.env });
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
  return { layer, commands };
}

const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

it.layer(
  Layer.mergeAll(
    layerTestNodeServices,
    ServerSettingsModule.layerTest(),
    layerTestHttpClient,
    OmpExecutableGate.layer,
    Layer.succeed(PtyAdapter, {
      spawn: () => Effect.die("Unexpected PTY launch in provider status fixture"),
    }),
  ),
)("ProviderRegistry", (it) => {
  describe("checkCodexProviderStatus", () => {
    it.effect("uses the app-server account and model list for provider status", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.succeed(
            makeCodexProbeSnapshot({
              skills: [
                {
                  name: "github:gh-fix-ci",
                  path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                  enabled: true,
                  displayName: "CI Debug",
                  shortDescription: "Debug failing GitHub Actions checks",
                },
              ],
            }),
          ),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.version, "1.0.0");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "chatgpt");
        assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
        assert.strictEqual(status.auth.email, "test@example.com");
        assert.deepStrictEqual(status.setup, { canAuthenticate: false, canInstall: false });
        assert.deepStrictEqual(status.models, [
          {
            slug: "gpt-live-codex",
            name: "GPT Live Codex",
            isCustom: false,
            capabilities: codexModelCapabilities,
            isDefault: true,
          },
        ]);
        assert.deepStrictEqual(status.skills, [
          {
            name: "github:gh-fix-ci",
            path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
            enabled: true,
            displayName: "CI Debug",
            shortDescription: "Debug failing GitHub Actions checks",
          },
        ]);
        assert.deepStrictEqual(status.slashCommands.slice(1), [
          {
            name: "goal",
            description: "Set a goal Codex keeps working toward until it is done",
            input: { hint: "Objective, or pause, resume, clear" },
          },
          {
            name: "feedback",
            description: "Send this thread and Codex logs to OpenAI",
            input: { hint: "Describe the issue (optional)" },
          },
        ]);
      }),
    );

    it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.succeed(
            makeCodexProbeSnapshot({
              account: {
                account: null,
                requiresOpenaiAuth: true,
              },
            }),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }),
    );

    it.effect("returns ready with unknown auth when app-server does not require OpenAI auth", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.succeed(
            makeCodexProbeSnapshot({
              account: {
                account: null,
                requiresOpenaiAuth: false,
              },
            }),
          ),
        );

        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "unknown");
      }),
    );
  });

  describe("ProviderRegistry.layer", () => {
    it("stores workspace skills, commands and options without changing machine metadata", () => {
      const provider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [{ name: "global" }],
        skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
      } satisfies ServerProvider;
      const scopedSnapshot = {
        ...provider,
        checkedAt: "2026-03-25T00:01:00.000Z",
        slashCommands: [{ name: "project" }],
        skills: [{ name: "project", path: "/project/SKILL.md", enabled: true }],
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: "readonly", label: "Readonly" }],
          },
        ],
      } satisfies ProviderWorkspaceSnapshot;

      const result = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        scopedSnapshot,
      );

      assert.deepStrictEqual(result.slashCommands, provider.slashCommands);
      assert.deepStrictEqual(result.skills, provider.skills);
      assert.strictEqual(result.models, provider.models);
      const decoded = decodeServerProvider(encodeServerProvider(result));
      assert.deepStrictEqual(decoded.workspaceSnapshots, [
        {
          cwd: "/project",
          checkedAt: scopedSnapshot.checkedAt,
          slashCommands: scopedSnapshot.slashCommands,
          skills: scopedSnapshot.skills,
          optionDescriptors: scopedSnapshot.optionDescriptors,
        },
      ]);

      const pendingSnapshot = {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
      } satisfies ProviderWorkspaceSnapshot;
      const partial = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        result,
        "/project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(partial.workspaceSnapshots?.[0]?.slashCommands, [{ name: "project" }]);
      assert.strictEqual(partial.workspaceSnapshots?.[0]?.slashCommandsPending, true);
      const otherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        partial,
        "/other-project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(otherProject.workspaceSnapshots?.[1]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
      ]);
      const recovered = ProviderRegistry.upsertProviderWorkspaceSnapshot(partial, "/project", {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND, { name: "replacement" }],
      });
      assert.deepStrictEqual(recovered.workspaceSnapshots?.[0]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
        { name: "replacement" },
      ]);
      assert.strictEqual(recovered.workspaceSnapshots?.[0]?.slashCommandsPending, undefined);

      const { optionDescriptors, ...failedSnapshot } = scopedSnapshot;
      const firstFailure = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(firstFailure.workspaceSnapshots![0]!, "optionDescriptors"),
        false,
      );
      const failedOtherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        recovered,
        "/other-project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(failedOtherProject.workspaceSnapshots![1]!, "optionDescriptors"),
        false,
      );

      for (const clearedDescriptors of [[], [{ ...optionDescriptors[0]!, options: [] }]]) {
        const cleared = ProviderRegistry.upsertProviderWorkspaceSnapshot(recovered, "/project", {
          ...scopedSnapshot,
          optionDescriptors: clearedDescriptors,
        });
        assert.deepStrictEqual(
          cleared.workspaceSnapshots?.[0]?.optionDescriptors,
          clearedDescriptors,
        );
      }

      const failedRefresh = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        failedOtherProject,
        "/project",
        failedSnapshot,
      );
      assert.deepStrictEqual(
        failedRefresh.workspaceSnapshots?.[1]?.optionDescriptors,
        optionDescriptors,
      );
    });

    it("preserves previously discovered provider models when a refresh returns none", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2026.04.09-f2b0fcd",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("reasoning", "Reasoning", [
                  { id: "high", label: "High", isDefault: true },
                ]),
                booleanDescriptor("fastMode", "Fast Mode"),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
        [],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
        [],
      );
    });

    it("does not bring back models the installed CLI is too old to run", () => {
      const pendingProvider = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "warning",
        enabled: true,
        installed: false,
        auth: { status: "unknown" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: null,
        models: [
          { slug: "claude-old", name: "Old", isCustom: false, capabilities: null },
          { slug: "claude-next", name: "Next", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const probedProvider = {
        ...pendingProvider,
        status: "ready",
        installed: true,
        auth: { status: "authenticated" },
        version: "1.0.0",
        models: [pendingProvider.models[0]],
        updateRequiredModels: [{ slug: "claude-next", name: "Next", minVersion: "1.1.0" }],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(pendingProvider, probedProvider).models,
        [...probedProvider.models],
      );
    });

    it("retains ACP Registry models while discovery has not completed", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("acpRegistry_codex"),
        driver: ProviderDriverKind.make("acpRegistry"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-08-13T00:00:00.000Z",
        version: "1.2.0",
        models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const checkingProvider = {
        ...previousProvider,
        checkedAt: "2026-08-13T00:01:00.000Z",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
        models: [{ slug: "default", name: "Default", isCustom: false, capabilities: null }],
      } satisfies ServerProvider;
      // A saved sign-in confirmation marks the readiness snapshot authenticated
      // before discovery has run.
      const confirmedCheckingProvider = {
        ...checkingProvider,
        auth: { status: "authenticated" },
      } satisfies ServerProvider;
      const failedProbeProvider = {
        ...checkingProvider,
        status: "warning",
        message: "ACP discovery failed.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, checkingProvider).models,
        [
          { slug: "default", name: "Default", isCustom: false, capabilities: null },
          { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
        ],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, confirmedCheckingProvider).models,
        [
          { slug: "default", name: "Default", isCustom: false, capabilities: null },
          { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
        ],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, failedProbeProvider).models,
        [
          { slug: "default", name: "Default", isCustom: false, capabilities: null },
          { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
        ],
      );
    });

    it("retains stale OpenCode models when a refresh fails", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-07-17T00:00:00.000Z",
        version: "1.0.0",
        models: [
          {
            slug: "github/gpt-5",
            name: "GPT-5",
            subProvider: "GitHub",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:01:00.000Z",
        models: [],
        message: "Failed to refresh OpenCode models.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
        previousProvider.slashCommands,
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
        previousProvider.skills,
      );
    });

    describe("Pi model inventories", () => {
      const defaultModel = {
        slug: "default",
        name: "Pi default",
        isCustom: false,
        capabilities: null,
      } as const;
      const currentModel = {
        slug: "openai/gpt-6.1-sol",
        name: "GPT-6.1-Sol",
        isCustom: false,
        capabilities: null,
      } as const;
      const removedModel = {
        slug: "openrouter/google/gemini-2.5-pro",
        name: "Google: Gemini 2.5 Pro",
        isCustom: false,
        capabilities: null,
      } as const;
      const customModel = {
        slug: "custom-model",
        name: "Custom model",
        isCustom: true,
        capabilities: null,
      } as const;
      const cachedProvider = {
        instanceId: ProviderInstanceId.make("pi-personal"),
        driver: ProviderDriverKind.make("pi"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated", type: "pi" },
        checkedAt: "2026-10-03T00:00:00.000Z",
        version: "1.0.0",
        models: [
          defaultModel,
          currentModel,
          removedModel,
          { ...customModel, slug: "removed-custom" },
        ],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const refreshedProvider = {
        ...cachedProvider,
        checkedAt: "2026-10-03T00:01:00.000Z",
        models: [defaultModel, currentModel, customModel],
      } satisfies ServerProvider;
      const pendingProvider = {
        ...cachedProvider,
        status: "warning",
        version: null,
        auth: { status: "unknown" },
        models: [defaultModel, customModel],
      } satisfies ServerProvider;
      const failedProvider = {
        ...pendingProvider,
        checkedAt: "2026-10-03T00:02:00.000Z",
        status: "ready",
        version: "1.0.0",
        message: "Pi is available, but T3 Code could not refresh its models and commands.",
      } satisfies ServerProvider;

      it("retains Pi inventories during incomplete probes without restoring removed custom models", () => {
        const incompleteProviders = [
          pendingProvider,
          { ...pendingProvider, installed: false },
          failedProvider,
          { ...failedProvider, status: "error" },
        ] satisfies ReadonlyArray<ServerProvider>;

        for (const provider of incompleteProviders) {
          assert.deepStrictEqual(
            ProviderRegistry.mergeProviderSnapshot(cachedProvider, provider).models,
            [defaultModel, customModel, currentModel, removedModel],
          );
        }
      });

      it("does not restore disconnected Pi models after a later discovery failure", () => {
        const afterRemoval = ProviderRegistry.mergeProviderSnapshot(
          cachedProvider,
          refreshedProvider,
        );
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(afterRemoval, failedProvider).models,
          [defaultModel, customModel, currentModel],
        );
      });

      it.effect(
        "persists Pi inventory removals across failed refreshes and registry restarts",
        () =>
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: cachedProvider.instanceId,
            });
            yield* writeProviderStatusCache({ filePath, provider: cachedProvider });
            const nextProvider = yield* Ref.make<ServerProvider>(refreshedProvider);
            const instance = {
              instanceId: cachedProvider.instanceId,
              driverKind: cachedProvider.driver,
              continuationIdentity: {
                driverKind: cachedProvider.driver,
                continuationKey: "pi:instance:pi-personal",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                resolveMaintenance: () =>
                  Effect.succeed(
                    makeManualOnlyProviderMaintenanceCapabilities({
                      provider: cachedProvider.driver,
                      packageName: null,
                    }),
                  ),
                getSnapshot: Effect.succeed(pendingProvider),
                refresh: Ref.get(nextProvider),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const layerInstanceRegistry = Layer.succeed(
              ProviderInstanceRegistry.ProviderInstanceRegistry,
              {
                getInstance: (id) =>
                  Effect.succeed(id === instance.instanceId ? instance : undefined),
                listInstances: Effect.succeed([instance]),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
                rebuildInstance: () =>
                  Effect.die("Unexpected instance rebuild in snapshot fixture"),
              },
            );
            // SCIENT-FORK:START — shared/scientModel.ts publishes the automatic choice to every client.
            const registryDefaultModel = { ...defaultModel, isDefault: true };
            const retainedModels = [registryDefaultModel, customModel, currentModel];
            // SCIENT-FORK:END

            for (const restarted of [false, true]) {
              yield* Effect.gen(function* () {
                const registry = yield* ProviderRegistry.ProviderRegistry;
                // SCIENT-FORK:START — registry snapshots include the automatic default.
                assert.deepStrictEqual(
                  (yield* registry.getProviders)[0]?.models,
                  restarted
                    ? retainedModels
                    : [registryDefaultModel, customModel, currentModel, removedModel],
                );
                // SCIENT-FORK:END

                yield* registry.refreshInstance(instance.instanceId);
                // SCIENT-FORK:START — persisted snapshots include the automatic default.
                assert.deepStrictEqual(
                  (yield* readProviderStatusCache(filePath))?.models,
                  restarted ? retainedModels : [registryDefaultModel, currentModel, customModel],
                );
                // SCIENT-FORK:END

                yield* Ref.set(nextProvider, failedProvider);
                const afterFailure = yield* registry.refreshInstance(instance.instanceId);
                assert.deepStrictEqual(afterFailure[0]?.models, retainedModels);
                assert.deepStrictEqual(
                  (yield* readProviderStatusCache(filePath))?.models,
                  retainedModels,
                );
              }).pipe(
                Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(layerInstanceRegistry))),
                Effect.scoped,
              );
            }
          }).pipe(
            Effect.provide(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-pi-model-cache-",
              }).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          ),
      );
    });

    describe("Codex model inventories", () => {
      const cachedProvider = {
        instanceId: ProviderInstanceId.make("codex-personal"),
        driver: ProviderDriverKind.make("codex"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-04T19:00:00.000Z",
        version: "0.153.3",
        models: ["vega-alpha", "joule-alpha", "kindle-alpha", "ultima-alpha", "solstice-alpha"].map(
          (slug) => ({ slug, name: slug, isCustom: false, capabilities: null }),
        ),
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const customModel = {
        slug: "custom-model",
        name: "Custom model",
        isCustom: true,
        capabilities: null,
      } as const;
      const refreshedProvider = {
        ...cachedProvider,
        checkedAt: "2026-09-04T19:01:00.000Z",
        models: [
          { slug: "gpt-6-astra", name: "GPT 6 Astra", isCustom: false, capabilities: null },
          cachedProvider.models[0]!,
          customModel,
        ],
      } satisfies ServerProvider;
      const pendingProvider = {
        ...cachedProvider,
        status: "warning",
        installed: false,
        auth: { status: "unknown" },
        models: [customModel],
      } satisfies ServerProvider;
      const failedProvider = {
        ...pendingProvider,
        checkedAt: "2026-09-04T19:02:00.000Z",
        status: "error",
        installed: true,
      } satisfies ServerProvider;

      it.effect("persists removals across failed refreshes and registry restarts", () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: cachedProvider.instanceId,
          });
          yield* writeProviderStatusCache({ filePath, provider: cachedProvider });
          const nextProvider = yield* Ref.make<ServerProvider>(refreshedProvider);
          const instance = {
            instanceId: cachedProvider.instanceId,
            driverKind: cachedProvider.driver,
            continuationIdentity: {
              driverKind: cachedProvider.driver,
              continuationKey: "codex:instance:codex-personal",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: cachedProvider.driver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(pendingProvider),
              refresh: Ref.get(nextProvider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (id) =>
                Effect.succeed(id === instance.instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const expectedCachedModels = [
            { ...cachedProvider.models[0]!, isDefault: true },
            ...cachedProvider.models.slice(1),
          ];
          const expectedRefreshedModels = [
            { ...refreshedProvider.models[0]!, isDefault: true },
            ...refreshedProvider.models.slice(1),
          ];
          const retainedModels = [
            customModel,
            ...expectedRefreshedModels.filter((model) => !model.isCustom),
          ];

          for (const restarted of [false, true]) {
            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const expectedModels = restarted
                ? retainedModels
                : [customModel, ...expectedCachedModels];
              assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, expectedModels);

              yield* registry.refreshInstance(instance.instanceId);
              assert.deepStrictEqual(
                (yield* readProviderStatusCache(filePath))?.models,
                restarted ? retainedModels : expectedRefreshedModels,
              );

              yield* Ref.set(nextProvider, failedProvider);
              const afterFailure = yield* registry.refreshInstance(instance.instanceId);
              assert.deepStrictEqual(afterFailure[0]?.models, retainedModels);
              assert.deepStrictEqual(
                (yield* readProviderStatusCache(filePath))?.models,
                retainedModels,
              );
            }).pipe(
              Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(layerInstanceRegistry))),
              Effect.scoped,
            );
          }
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-codex-retired-model-cache-",
            }).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
      );
    });

    describe("Antigravity model inventories", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("antigravity-personal"),
        driver: ProviderDriverKind.make("antigravity"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-02T00:00:00.000Z",
        version: "0.1.3",
        models: [
          {
            slug: "gemini-3.1-pro-high",
            name: "Gemini 3.1 Pro High",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "gemini-3-flash",
            name: "Gemini 3 Flash",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;

      it("clears models after sign-out, disable, uninstall, or an empty successful refresh", () => {
        const emptyProvider = {
          ...previousProvider,
          checkedAt: "2026-09-02T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const clearedProviders = [
          { ...emptyProvider, status: "warning", auth: { status: "unauthenticated" } },
          { ...emptyProvider, status: "error", auth: { status: "unauthenticated" } },
          { ...emptyProvider, status: "disabled", enabled: false },
          { ...emptyProvider, status: "error", enabled: false },
          { ...emptyProvider, status: "error", installed: false, auth: { status: "unknown" } },
          emptyProvider,
        ] satisfies ReadonlyArray<ServerProvider>;

        for (const provider of clearedProviders) {
          const afterRemoval = ProviderRegistry.mergeProviderSnapshot(previousProvider, provider);
          assert.deepStrictEqual(afterRemoval.models, []);

          const afterFailure = ProviderRegistry.mergeProviderSnapshot(afterRemoval, {
            ...emptyProvider,
            status: "error",
            auth: { status: "unknown" },
          });
          assert.deepStrictEqual(afterFailure.models, []);
        }
      });
    });

    describe("Antigravity saved account", () => {
      const signedIn = {
        instanceId: ProviderInstanceId.make("antigravity-personal"),
        driver: ProviderDriverKind.make("antigravity"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
        checkedAt: "2026-09-05T00:00:00.000Z",
        version: "agy_acp_server_1.1.1",
        models: [
          {
            slug: "gemini-3.7-flash-high",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [{ name: "plan" }],
        skills: [],
      } as const satisfies ServerProvider;
      const uncheckedMessage =
        "Antigravity is installed. Google account access is not checked yet.";
      const restartProbe = {
        ...signedIn,
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: "2026-09-05T00:01:00.000Z",
        message: uncheckedMessage,
        models: [],
      } as const satisfies ServerProvider;

      it("keeps the saved Google account through restart health checks", () => {
        const merged = ProviderRegistry.mergeProviderSnapshot(signedIn, restartProbe);
        const { message: _uncheckedMessage, ...probeWithoutMessage } = restartProbe;
        assert.deepStrictEqual(merged, {
          ...probeWithoutMessage,
          status: "ready",
          auth: signedIn.auth,
          models: signedIn.models,
        });
        assert.equal("message" in merged, false);
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(merged, restartProbe),
          merged,
        );
      });

      it("does not invent an account after sign-out, disable, uninstall, or for other providers", () => {
        const untouched = [
          { ...restartProbe, auth: { status: "unauthenticated" } },
          { ...restartProbe, status: "disabled", enabled: false },
          { ...restartProbe, status: "error", installed: false },
          { ...restartProbe, driver: ProviderDriverKind.make("codex") },
          { ...restartProbe, auth: { status: "unknown", type: "gemini-api-key" } },
        ] satisfies ReadonlyArray<ServerProvider>;
        for (const next of untouched) {
          const merged = ProviderRegistry.mergeProviderSnapshot(signedIn, next);
          assert.deepStrictEqual(merged.auth, next.auth);
          assert.equal(merged.status, next.status);
          assert.equal(merged.message, next.message);
        }
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(
            { ...signedIn, auth: { status: "unknown" } },
            restartProbe,
          ).auth,
          { status: "unknown" },
        );
        assert.equal(
          ProviderRegistry.mergeProviderSnapshot(
            { ...signedIn, driver: ProviderDriverKind.make("codex") },
            restartProbe,
          ).auth.status,
          "unknown",
        );
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(signedIn, {
            ...restartProbe,
            auth: { status: "unknown", type: "oauth-personal" },
          }).auth,
          signedIn.auth,
        );
      });
    });

    it("fills missing capabilities from the previous provider snapshot", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2026.04.09-f2b0fcd",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("reasoning", "Reasoning", [
                  { id: "high", label: "High", isDefault: true },
                ]),
                booleanDescriptor("fastMode", "Fast Mode"),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [],
            }),
          },
        ],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
    });

    it.effect("does not run provider probes during layer construction", () =>
      Effect.gen(function* () {
        const codexDriver = ProviderDriverKind.make("codex");
        const codexInstanceId = ProviderInstanceId.make("codex");
        const initialProvider = {
          instanceId: codexInstanceId,
          driver: codexDriver,
          status: "warning",
          enabled: true,
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: null,
          message: "Checking Codex provider status.",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshCalls = yield* Ref.make(0);
        const instance = {
          instanceId: codexInstanceId,
          driverKind: codexDriver,
          continuationIdentity: {
            driverKind: codexDriver,
            continuationKey: "codex:instance:codex",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: codexDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.never),
            ),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-background-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);
          assert.strictEqual(yield* Ref.get(refreshCalls), 0);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    const updateScenarios = [
      "healthy",
      "unauthenticated",
      "sibling defects",
      "selected defect",
      "selected disabled",
    ] as const;
    it.effect.each(updateScenarios)("refreshes account caches after update (%s)", (scenario) =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("example");
        const packageName = "@example/provider";
        const manifestRefreshes = yield* Ref.make(0);
        const events: string[] = [];
        const manifest = {
          version: 1,
          currentModels: {},
          compatibility: [{ driver, t3CodeRange: ">=0.0.42", ranges: [] }],
        } satisfies ModelManifest.ModelManifestData;
        const makeInstance = (
          id: string,
          config: { binaryPath: string; home: string; model: string },
          enabled = true,
          driverKind = driver,
        ): ProviderInstance => {
          const instanceId = ProviderInstanceId.make(id);
          const provider = {
            instanceId,
            driver: driverKind,
            status: scenario === "unauthenticated" ? "error" : "ready",
            enabled,
            installed: true,
            auth: {
              status:
                scenario === "unauthenticated" || scenario === "selected defect"
                  ? "unauthenticated"
                  : "authenticated",
              label: config.home,
            },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: scenario === "selected defect" && id === "personal" ? "2.0.0" : "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          let cached = true;
          return {
            instanceId,
            driverKind,
            continuationIdentity: { driverKind, continuationKey: config.home },
            displayName: undefined,
            enabled,
            snapshot: {
              resolveMaintenance: () =>
                Effect.sync(() => {
                  if (id === "broken-maintenance" && events.includes("update")) {
                    throw new Error("Sibling maintenance failed");
                  }
                  return makeProviderMaintenanceCapabilities({
                    provider: driverKind,
                    packageName: scenario === "selected defect" ? null : packageName,
                    updateExecutable: config.binaryPath,
                    updateArgs: ["update"],
                    env: { PROVIDER_HOME: config.home },
                    updateLockKey: config.binaryPath,
                    latestVersion: scenario === "selected defect" ? null : "2.0.0",
                  });
                }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.sync(() => {
                events.push(`probe:${id}`);
                if (
                  id === "broken-discovery" ||
                  (scenario === "selected defect" && id === "personal")
                ) {
                  throw new Error("Provider discovery failed");
                }
                return cached
                  ? provider
                  : {
                      ...provider,
                      version: "2.0.0",
                      models: [
                        {
                          slug: config.model,
                          name: config.model,
                          isCustom: false,
                          capabilities: createModelCapabilities({ optionDescriptors: [] }),
                        },
                      ],
                    };
              }),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            invalidateCaches: Effect.sync(() => {
              cached = false;
              events.push(`invalidate:${id}`);
            }),
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          };
        };
        const instances = [
          makeInstance(
            "personal",
            { binaryPath: "/personal/agent", home: "/personal", model: "personal-model" },
            scenario !== "selected disabled",
          ),
          makeInstance("work", { binaryPath: "/work/agent", home: "/work", model: "work-model" }),
          ...(scenario === "sibling defects"
            ? ["broken-maintenance", "broken-discovery"].map((id) =>
                makeInstance(id, { binaryPath: `/${id}/agent`, home: `/${id}`, model: id }),
              )
            : []),
          makeInstance(
            "disabled",
            { binaryPath: "/disabled/agent", home: "/disabled", model: "disabled-model" },
            false,
          ),
          makeInstance(
            "unrelated",
            { binaryPath: "/other/agent", home: "/other", model: "other-model" },
            true,
            ProviderDriverKind.make("other"),
          ),
        ];
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderMaintenanceRunner.layer.pipe(
            Layer.provideMerge(ProviderRegistry.layer),
            Layer.provideMerge(ProviderLifecycleCoordinator.layer),
            Layer.provideMerge(
              Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
                getInstance: (instanceId) =>
                  Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
                rebuildInstance: () => Effect.void,
                listInstances: Effect.succeed(instances),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(ModelManifest.ModelManifest, {
                current: Effect.succeed(manifest),
                refresh: Effect.succeed(manifest),
                forceRefresh: Ref.update(manifestRefreshes, (count) => count + 1).pipe(
                  Effect.as(manifest),
                ),
                refreshInBackground: Effect.void,
              }),
            ),
            Layer.provideMerge(
              Layer.effect(
                ProviderLatestVersions.ProviderLatestVersions,
                ProviderLatestVersions.make([
                  [packageName, "1.0.0"],
                  ["unrelated-package", "1.0.0"],
                ]),
              ),
            ),
            Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provideMerge(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) =>
                  Effect.sync(() => {
                    assert.strictEqual(command._tag, "StandardCommand");
                    if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
                    assert.strictEqual(command.command, "/personal/agent");
                    assert.deepStrictEqual(command.args, ["update"]);
                    assert.strictEqual(command.options.env?.PROVIDER_HOME, "/personal");
                    events.push("update");
                    return mockHandle({ stdout: "updated", stderr: "", code: 0 });
                  }),
                ),
              ),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-update-caches-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
          const before = yield* registry.getProviders;
          if (scenario === "selected defect") {
            const selected = before.find((p) => p.instanceId === "personal");
            assert.strictEqual(selected?.version, "2.0.0");
            assert.strictEqual(selected?.status, "ready");
            assert.strictEqual(selected?.auth.status, "unauthenticated");
            assert.strictEqual(selected?.versionAdvisory, undefined);
          }
          const result = yield* runner.updateProvider({
            provider: driver,
            instanceId: ProviderInstanceId.make("personal"),
          });
          assert.strictEqual(
            result.providers.find((p) => p.instanceId === "personal")?.updateState?.status,
            scenario === "selected defect" ? "unchanged" : "succeeded",
          );
          assert.deepStrictEqual(
            events.filter((event) => event === "update"),
            ["update"],
          );
          assert.strictEqual(events[0], "update");
          assert.deepStrictEqual(
            events.filter((event) => event.startsWith("probe:")).toSorted(),
            [
              "probe:personal",
              "probe:work",
              ...(scenario === "sibling defects" ? ["probe:broken-discovery"] : []),
            ].toSorted(),
          );
          for (const id of ["personal", "work"]) {
            assert.isBelow(events.indexOf(`invalidate:${id}`), events.indexOf(`probe:${id}`));
            assert.include(events, `invalidate:${id}`);
            const provider = result.providers.find((p) => p.instanceId === id);
            assert.deepStrictEqual(
              provider?.models.map((model) => model.slug),
              scenario === "selected defect" && id === "personal" ? [] : [`${id}-model`],
            );
            assert.strictEqual(provider?.auth.label, `/${id}`);
            if (scenario === "unauthenticated") {
              assert.strictEqual(provider?.status, "error");
              assert.strictEqual(provider?.auth.status, "unauthenticated");
              assert.strictEqual(provider?.version, "2.0.0");
            }
          }
          for (const id of scenario === "sibling defects"
            ? ["broken-maintenance", "broken-discovery"]
            : scenario === "selected defect"
              ? ["personal"]
              : []) {
            assert.strictEqual(result.providers.find((p) => p.instanceId === id)?.status, "error");
          }
          assert.isAtLeast(yield* Ref.get(manifestRefreshes), 1);
          assert.strictEqual(
            yield* latestVersions.cached(packageName, Effect.succeed("2.0.0")),
            scenario === "selected defect" ? "1.0.0" : "2.0.0",
          );
          assert.strictEqual(
            yield* latestVersions.cached("unrelated-package", Effect.succeed("2.0.0")),
            "1.0.0",
          );
          assert.strictEqual(
            result.providers.find((p) => p.instanceId === "work")?.updateState,
            undefined,
          );
          for (const id of ["disabled", "unrelated"]) {
            assert.notInclude(events, `invalidate:${id}`);
            assert.deepStrictEqual(
              result.providers.find((p) => p.instanceId === id),
              before.find((p) => p.instanceId === id),
            );
          }
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("deduplicates cwd probes and clears snapshots when an instance rebuilds", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const machineProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [{ name: "global" }],
          skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
        } as const satisfies ServerProvider;
        const scopedProvider = {
          ...machineProvider,
          checkedAt: "2026-06-10T00:01:00.000Z",
          slashCommands: [{ name: "project" }],
          skills: [{ name: "project", path: "/workspace/SKILL.md", enabled: true }],
        } as const satisfies ServerProvider;
        const snapshotCalls = yield* Ref.make(0);
        const scopedResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...scopedProvider,
          status: "error",
          slashCommands: [COMPACT_SLASH_COMMAND],
          slashCommandsPending: true,
        });
        const cacheInvalidations = yield* Ref.make(0);
        const scanGate = yield* Ref.make<{
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null>(null);
        const failScan = yield* Ref.make(true);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const makeInstance = (
          provider: ServerProvider,
          snapshotForCwd: NonNullable<ProviderInstance["snapshotForCwd"]>,
        ): ProviderInstance => ({
          instanceId,
          driverKind: driver,
          continuationIdentity: {
            driverKind: driver,
            continuationKey: "codex:instance:codex",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(provider),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd,
          invalidateCaches: Ref.update(cacheInvalidations, (count) => count + 1),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        });
        const firstInstance = makeInstance(machineProvider, () =>
          Effect.gen(function* () {
            yield* Ref.update(snapshotCalls, (count) => count + 1);
            if (yield* Ref.get(failScan)) {
              return yield* new ProviderDriverError({
                driver,
                instanceId,
                detail: "The workspace scan failed.",
              });
            }
            yield* Deferred.succeed(probeStarted, undefined);
            yield* Deferred.await(releaseProbe);
            const result = yield* Ref.get(scopedResult);
            const gate = yield* Ref.getAndSet(scanGate, null);
            if (gate) {
              yield* Deferred.succeed(gate.started, undefined);
              yield* Deferred.await(gate.release);
            }
            return result;
          }),
        );
        const rebuiltProvider = {
          ...machineProvider,
          checkedAt: "2026-06-10T00:02:00.000Z",
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
        } satisfies ServerProvider;
        const rebuiltInstance = makeInstance(rebuiltProvider, () =>
          Ref.update(snapshotCalls, (count) => count + 1).pipe(Effect.as(scopedProvider)),
        );
        const registryChanges = yield* PubSub.unbounded<void>();
        const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([firstInstance]);
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Ref.get(instancesRef).pipe(
                Effect.map((instances) =>
                  instances.find((instance) => instance.instanceId === requestedId),
                ),
              ),
            listInstances: Ref.get(instancesRef),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.fromPubSub(registryChanges),
            subscribeChanges: PubSub.subscribe(registryChanges),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-workspace-snapshot-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual((yield* registry.getProviders)[0]?.workspaceSnapshots, undefined);
          yield* Ref.set(failScan, false);
          const workspaceUpdate = yield* registry.streamChanges.pipe(
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          const firstRefresh = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const duplicateRefresh = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(snapshotCalls), 2);
          yield* Deferred.succeed(releaseProbe, undefined);
          yield* Fiber.join(firstRefresh);
          yield* Fiber.join(duplicateRefresh);
          const published = yield* Fiber.join(workspaceUpdate);
          assert.strictEqual(published._tag, "Some");
          const providers = yield* registry.getProviders;
          assert.deepStrictEqual(providers[0]?.skills, machineProvider.skills);
          assert.deepStrictEqual(
            providers[0]?.workspaceSnapshots?.[0]?.skills,
            scopedProvider.skills,
          );
          assert.deepStrictEqual(providers[0]?.workspaceSnapshots?.[0]?.slashCommands, [
            COMPACT_SLASH_COMMAND,
          ]);
          assert.strictEqual(providers[0]?.workspaceSnapshots?.[0]?.slashCommandsPending, true);
          yield* Ref.set(scopedResult, {
            ...scopedProvider,
            status: "error",
            slashCommandsPending: false,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 3);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.slashCommands,
            scopedProvider.slashCommands,
          );
          assert.strictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.slashCommandsPending,
            undefined,
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 3);
          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS - 1);
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 3);
          yield* TestClock.adjust(1);
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 4);
          const newSkills = [
            ...scopedProvider.skills,
            { name: "added", path: "/workspace/added/SKILL.md", enabled: true },
          ];
          yield* Ref.set(scopedResult, { ...scopedProvider, skills: newSkills });
          yield* registry.refreshWorkspaceSnapshot({
            instanceId,
            cwd: "/workspace",
            fresh: true,
          });
          assert.strictEqual(yield* Ref.get(snapshotCalls), 5);
          assert.strictEqual(yield* Ref.get(cacheInvalidations), 1);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((s) => s.skills),
            [newSkills],
          );

          const slowStarted = yield* Deferred.make<void>();
          const releaseSlow = yield* Deferred.make<void>();
          yield* Ref.set(scanGate, { started: slowStarted, release: releaseSlow });
          yield* Ref.set(scopedResult, scopedProvider);
          const slowScan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace", fresh: true })
            .pipe(Effect.forkChild);
          yield* Deferred.await(slowStarted);
          const latestSkills = [
            ...newSkills,
            { name: "latest", path: "/workspace/latest/SKILL.md", enabled: true },
          ];
          yield* Ref.set(scopedResult, { ...scopedProvider, skills: latestSkills });
          yield* registry.refreshWorkspaceSnapshot({
            instanceId,
            cwd: "/workspace",
            fresh: true,
          });
          yield* Deferred.succeed(releaseSlow, undefined);
          yield* Fiber.join(slowScan);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((s) => s.skills),
            [latestSkills],
          );

          // With no cached snapshot, an older scan must leave publication and
          // request deduplication to the forced scan even when it finishes first.
          const olderStarted = yield* Deferred.make<void>();
          const releaseOlder = yield* Deferred.make<void>();
          yield* Ref.set(scanGate, { started: olderStarted, release: releaseOlder });
          yield* Ref.set(scopedResult, scopedProvider);
          const olderScan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace2" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(olderStarted);
          const newerStarted = yield* Deferred.make<void>();
          const releaseNewer = yield* Deferred.make<void>();
          yield* Ref.set(scanGate, { started: newerStarted, release: releaseNewer });
          yield* Ref.set(scopedResult, { ...scopedProvider, skills: latestSkills });
          const newerScan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace2", fresh: true })
            .pipe(Effect.forkChild);
          yield* Deferred.await(newerStarted);
          yield* Deferred.succeed(releaseOlder, undefined);
          yield* Fiber.join(olderScan);
          assert.strictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.find(
              (snapshot) => snapshot.cwd === "/workspace2",
            ),
            undefined,
          );
          const callsWhileForced = yield* Ref.get(snapshotCalls);
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace2" });
          assert.strictEqual(yield* Ref.get(snapshotCalls), callsWhileForced);
          yield* Deferred.succeed(releaseNewer, undefined);
          yield* Fiber.join(newerScan);
          assert.deepStrictEqual(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.find(
              (snapshot) => snapshot.cwd === "/workspace2",
            )?.skills,
            latestSkills,
          );

          yield* Ref.set(instancesRef, [rebuiltInstance]);
          yield* PubSub.publish(registryChanges, undefined);
          let rebuilt = yield* registry.getProviders;
          for (
            let attempt = 0;
            attempt < 50 && rebuilt[0]?.checkedAt !== rebuiltProvider.checkedAt;
            attempt += 1
          ) {
            yield* Effect.yieldNow;
            rebuilt = yield* registry.getProviders;
          }
          assert.strictEqual(rebuilt[0]?.checkedAt, rebuiltProvider.checkedAt);
          assert.strictEqual(rebuilt[0]?.workspaceSnapshots, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("publishes workspace skills while machine health is in error", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const healthyProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [COMPACT_SLASH_COMMAND],
          skills: [],
        } as const satisfies ServerProvider;
        // Codex's account check failed; its skill scan did not.
        const unhealthyProvider = {
          ...healthyProvider,
          status: "error",
          auth: { status: "unknown" },
          message: "Codex app-server provider probe failed: unauthorized (401).",
          slashCommands: [],
        } as const satisfies ServerProvider;
        const firstSkills = [{ name: "first", path: "/workspace/first/SKILL.md", enabled: true }];
        const laterSkills = [{ name: "later", path: "/workspace/later/SKILL.md", enabled: true }];
        const scanResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...healthyProvider,
          skills: firstSkills,
        });
        const instance: ProviderInstance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(unhealthyProvider),
            refresh: Effect.succeed(unhealthyProvider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () => Ref.get(scanResult),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(requestedId === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-unhealthy-workspace-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const workspaceOf = Effect.map(
            registry.getProviders,
            (providers) => providers[0]?.workspaceSnapshots?.[0],
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.slashCommands, [COMPACT_SLASH_COMMAND]);

          // An expired scan runs while the account check fails: the skills are
          // current, but commands that ride on the health check are unknown.
          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const unhealthy = yield* workspaceOf;
          assert.deepStrictEqual(unhealthy?.skills, laterSkills);
          assert.deepStrictEqual(unhealthy?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(unhealthy?.slashCommandsPending, true);
          const provider = (yield* registry.getProviders)[0];
          assert.strictEqual(provider?.status, "error");
          assert.strictEqual(provider?.message, unhealthyProvider.message);

          // A pending entry is rescanned on the next request; an empty scan
          // removes the skills.
          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: [] });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.skills, []);

          // A driver that discovers its own commands reports them even while
          // health is in error.
          const discoveredCommand = { name: "review", description: "Review changes" };
          yield* Ref.set(scanResult, {
            ...unhealthyProvider,
            slashCommands: [discoveredCommand],
            slashCommandsPending: false,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const discovered = yield* workspaceOf;
          assert.deepStrictEqual(discovered?.slashCommands, [discoveredCommand]);
          assert.strictEqual(discovered?.slashCommandsPending, undefined);

          // Once health recovers, the next scan restores the full entry.
          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...healthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const recovered = yield* workspaceOf;
          assert.deepStrictEqual(recovered?.skills, laterSkills);
          assert.deepStrictEqual(recovered?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(recovered?.slashCommandsPending, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("refreshes OpenCode catalogs and preserves other providers", () =>
      Effect.gen(function* () {
        const codexDriver = ProviderDriverKind.make("codex");
        const openCodeDriver = ProviderDriverKind.make("opencode");
        const codexInstanceId = ProviderInstanceId.make("codex");
        const openCodeInstanceId = ProviderInstanceId.make("opencode");
        const codexRefreshCalls = yield* Ref.make(0);
        const openCodeRefreshCalls = yield* Ref.make(0);
        const codexProvider = {
          instanceId: codexInstanceId,
          driver: codexDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const failedOpenCodeProvider = {
          instanceId: openCodeInstanceId,
          driver: openCodeDriver,
          status: "error",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          message: "Failed to refresh OpenCode models.",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const recoveredOpenCodeProvider = {
          ...failedOpenCodeProvider,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:01:00.000Z",
          message: "One upstream provider connected through OpenCode.",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
        } as const satisfies ServerProvider;
        const changedCatalogProvider = {
          ...recoveredOpenCodeProvider,
          checkedAt: "2026-06-10T00:02:00.000Z",
          models: [
            {
              slug: "anthropic/claude-sonnet-4",
              name: "Claude Sonnet 4",
              subProvider: "Anthropic",
              isCustom: false,
              capabilities: null,
            },
          ],
        } as const satisfies ServerProvider;
        const catalogSnapshot = yield* Ref.make<ServerProvider>(recoveredOpenCodeProvider);
        const instances = [
          {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: codexDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(codexProvider),
              refresh: Ref.update(codexRefreshCalls, (count) => count + 1).pipe(
                Effect.as(codexProvider),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
          {
            instanceId: openCodeInstanceId,
            driverKind: openCodeDriver,
            continuationIdentity: {
              driverKind: openCodeDriver,
              continuationKey: "opencode:instance:opencode",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: openCodeDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(failedOpenCodeProvider),
              refresh: Ref.update(openCodeRefreshCalls, (count) => count + 1).pipe(
                Effect.andThen(Ref.get(catalogSnapshot)),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
        ] satisfies ReadonlyArray<ProviderInstance>;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-reconnect-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const initialProviders = yield* registry.getProviders;
          assert.strictEqual(
            initialProviders.find((provider) => provider.instanceId === openCodeInstanceId)?.status,
            "error",
          );

          const recoveredProviders = yield* registry.refresh();
          assert.deepStrictEqual(
            recoveredProviders.find((provider) => provider.instanceId === openCodeInstanceId)
              ?.models,
            [{ ...recoveredOpenCodeProvider.models[0], isDefault: true }],
          );
          assert.deepStrictEqual(
            recoveredProviders.find((provider) => provider.instanceId === codexInstanceId),
            withBundledCompatibility(codexProvider),
          );

          yield* Ref.set(catalogSnapshot, changedCatalogProvider);
          const changedProviders = yield* registry.refresh();
          assert.deepStrictEqual(
            changedProviders.find((provider) => provider.instanceId === openCodeInstanceId)?.models,
            [{ ...changedCatalogProvider.models[0], isDefault: true }],
          );
          assert.deepStrictEqual(
            changedProviders.find((provider) => provider.instanceId === codexInstanceId),
            withBundledCompatibility(codexProvider),
          );
        }).pipe(Effect.provide(runtimeServices));

        assert.strictEqual(yield* Ref.get(codexRefreshCalls), 2);
        assert.strictEqual(yield* Ref.get(openCodeRefreshCalls), 2);
      }),
    );

    it.effect("shares one in-flight pass between concurrent untargeted refreshes", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const provider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshCalls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const instances = [
          {
            instanceId,
            driverKind: driver,
            continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: driver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.gen(function* () {
                yield* Ref.update(refreshCalls, (count) => count + 1);
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
                return provider;
              }),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
        ] satisfies ReadonlyArray<ProviderInstance>;
        const instanceRegistryLayer = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === requestedId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-shared-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const first = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const second = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);
          yield* Deferred.succeed(releaseProbe, undefined);
          expect(yield* Fiber.join(first)).toEqual([expect.objectContaining(provider)]);
          expect(yield* Fiber.join(second)).toEqual([expect.objectContaining(provider)]);
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);

          yield* registry.refresh();
          assert.strictEqual(yield* Ref.get(refreshCalls), 2);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("persists the merged snapshot when a live update has empty models", () =>
      Effect.gen(function* () {
        const cursorDriver = ProviderDriverKind.make("cursor");
        const cursorInstanceId = ProviderInstanceId.make("cursor");
        const initialProvider = {
          instanceId: cursorInstanceId,
          driver: cursorDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...initialProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const sourceSubscribed = yield* Deferred.make<void>();
        const cacheWrites = makeProviderCacheWriteObserver();
        const instance = {
          instanceId: cursorInstanceId,
          driverKind: cursorDriver,
          continuationIdentity: {
            driverKind: cursorDriver,
            continuationKey: "cursor:instance:cursor",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: cursorDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(refreshedProvider),
            streamChanges: Stream.unwrap(
              PubSub.subscribe(changes).pipe(
                Effect.tap(() => Deferred.succeed(sourceSubscribed, undefined)),
                Effect.map(Stream.fromSubscription),
              ),
            ),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-merged-persist-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            cacheWrites.layer,
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: cursorInstanceId,
          });

          const expectedModels = [{ ...initialProvider.models[0], isDefault: true }];
          assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, expectedModels);
          yield* Deferred.await(sourceSubscribed);
          const persisted = yield* cacheWrites.awaitPersisted(
            filePath,
            refreshedProvider.checkedAt,
          );
          yield* PubSub.publish(changes, refreshedProvider);
          yield* Fiber.join(persisted);
          const cachedProvider = yield* readProviderStatusCache(filePath);

          assert.deepStrictEqual(
            cachedProvider,
            withBundledCompatibility({
              ...refreshedProvider,
              models: expectedModels,
            }),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect(
      "persists authoritative OpenCode removals without resurrecting them on a failed live refresh",
      () =>
        Effect.gen(function* () {
          const openCodeDriver = ProviderDriverKind.make("opencode");
          const openCodeInstanceId = ProviderInstanceId.make("opencode");
          const initialProvider = {
            instanceId: openCodeInstanceId,
            driver: openCodeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-07-17T00:00:00.000Z",
            version: "1.0.0",
            models: [
              {
                slug: "github/gpt-5",
                name: "GPT-5",
                subProvider: "GitHub",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "removed-plugin/model",
                name: "Removed Plugin Model",
                subProvider: "Removed Plugin",
                isCustom: false,
                capabilities: null,
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const authoritativeProvider = {
            ...initialProvider,
            checkedAt: "2026-07-17T00:01:00.000Z",
            models: [initialProvider.models[0]!],
          } satisfies ServerProvider;
          const failedProvider = {
            ...authoritativeProvider,
            status: "error",
            auth: { status: "unknown" },
            checkedAt: "2026-07-17T00:02:00.000Z",
            models: [],
            message: "Failed to refresh OpenCode models.",
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const sourceSubscribed = yield* Deferred.make<void>();
          const cacheWrites = makeProviderCacheWriteObserver();
          const instance = {
            instanceId: openCodeInstanceId,
            driverKind: openCodeDriver,
            continuationIdentity: {
              driverKind: openCodeDriver,
              continuationKey: "opencode:instance:opencode",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: openCodeDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(authoritativeProvider),
              streamChanges: Stream.unwrap(
                PubSub.subscribe(changes).pipe(
                  Effect.tap(() => Deferred.succeed(sourceSubscribed, undefined)),
                  Effect.map(Stream.fromSubscription),
                ),
              ),
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(layerInstanceRegistry),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-opencode-authoritative-persist-",
                }),
              ),
              cacheWrites.layer,
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const config = yield* ServerConfig.ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: openCodeInstanceId,
            });

            yield* Deferred.await(sourceSubscribed);
            const authoritativePersisted = yield* cacheWrites.awaitPersisted(
              filePath,
              authoritativeProvider.checkedAt,
            );
            yield* PubSub.publish(changes, authoritativeProvider);
            yield* Fiber.join(authoritativePersisted);
            let cachedProvider = yield* readProviderStatusCache(filePath);

            const expectedModels = [{ ...authoritativeProvider.models[0]!, isDefault: true }];
            assert.deepStrictEqual(cachedProvider?.models, expectedModels);

            const failedPersisted = yield* cacheWrites.awaitPersisted(
              filePath,
              failedProvider.checkedAt,
            );
            yield* PubSub.publish(changes, failedProvider);
            yield* Fiber.join(failedPersisted);
            cachedProvider = yield* readProviderStatusCache(filePath);

            assert.deepStrictEqual(cachedProvider?.models, expectedModels);
            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, expectedModels);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );

    it.effect("returns the cached provider list when a manual refresh fails", () =>
      Effect.gen(function* () {
        const codexDriver = ProviderDriverKind.make("codex");
        const codexInstanceId = ProviderInstanceId.make("codex");
        const cachedProvider = {
          instanceId: codexInstanceId,
          driver: codexDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const instance = {
          instanceId: codexInstanceId,
          driverKind: codexDriver,
          continuationIdentity: {
            driverKind: codexDriver,
            continuationKey: "codex:instance:codex",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: codexDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(cachedProvider),
            refresh: Effect.die(new Error("simulated refresh failure")),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-refresh-failure-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;

          assert.deepStrictEqual(yield* registry.getProviders, [
            withBundledCompatibility(cachedProvider),
          ]);
          assert.deepStrictEqual(yield* registry.refresh(codexDriver), [
            withBundledCompatibility(cachedProvider),
          ]);
          assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
            withBundledCompatibility(cachedProvider),
          ]);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("keeps consuming registry changes after one sync fails", () =>
      Effect.gen(function* () {
        const codexDriver = ProviderDriverKind.make("codex");
        const codexInstanceId = ProviderInstanceId.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
        const codexProvider = {
          instanceId: codexInstanceId,
          driver: codexDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const claudeProvider = {
          instanceId: claudeInstanceId,
          driver: claudeDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:01:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const makeInstance = (provider: ServerProvider): ProviderInstance => ({
          instanceId: provider.instanceId,
          driverKind: provider.driver,
          continuationIdentity: {
            driverKind: provider.driver,
            continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: provider.driver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(provider),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        });
        const codexInstance = makeInstance(codexProvider);
        const claudeInstance = makeInstance(claudeProvider);
        const changes = yield* PubSub.unbounded<void>();
        const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
        const failNextList = yield* Ref.make(false);
        const wait = () => Effect.yieldNow;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Ref.get(instancesRef).pipe(
                Effect.map((instances) =>
                  instances.find((instance) => instance.instanceId === instanceId),
                ),
              ),
            listInstances: Effect.gen(function* () {
              const shouldFail = yield* Ref.get(failNextList);
              if (shouldFail) {
                yield* Ref.set(failNextList, false);
                return yield* Effect.die(new Error("simulated registry list failure"));
              }
              return yield* Ref.get(instancesRef);
            }),
            listUnavailable: Effect.succeed([]),
            rebuildInstance: () => Effect.die("Unexpected instance rebuild in snapshot fixture"),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-sync-failure-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          assert.deepStrictEqual(yield* registry.getProviders, [
            withBundledCompatibility(codexProvider),
          ]);

          yield* Ref.set(failNextList, true);
          yield* PubSub.publish(changes, undefined);

          yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
          yield* PubSub.publish(changes, undefined);

          let providers = yield* registry.getProviders;
          for (
            let attempt = 0;
            attempt < 50 && !providers.some((provider) => provider.instanceId === claudeInstanceId);
            attempt += 1
          ) {
            yield* wait();
            providers = yield* registry.getProviders;
          }

          assert.deepStrictEqual(
            providers.map((provider) => provider.instanceId).toSorted(),
            [codexInstanceId, claudeInstanceId].toSorted(),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("propagates real Codex probe failures to the aggregator at boot", () =>
      Effect.gen(function* () {
        const missingBinary = `t3code_codex_missing_`;
        const serverSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings(
            deepMerge(encodedDefaultServerSettings, {
              providerInstances: {
                ...disabledDefaultSlots("codex", "claudeAgent", "cursor", "grok", "opencode"),
                codex_personal: {
                  driver: "codex",
                  displayName: "Codex Personal",
                  enabled: true,
                  config: {
                    binaryPath: missingBinary,
                    homePath: `/tmp/${missingBinary}_home`,
                  },
                },
              } as unknown as ContractServerSettings["providerInstances"],
            }),
          ),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
          Layer.provideMerge(scientAntigravityInstallationLayer),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-provider-registry-",
            }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ModelManifest.layerTest),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          let providers = yield* registry.getProviders;
          for (
            let attempts = 0;
            attempts < 50 &&
            providers.find((provider) => provider.instanceId === "codex_personal")?.status !==
              "error";
            attempts += 1
          ) {
            yield* Effect.yieldNow;
            providers = yield* registry.getProviders;
          }
          const codexPersonal = providers.find(
            (provider) => provider.instanceId === "codex_personal",
          );
          assert.notStrictEqual(
            codexPersonal,
            undefined,
            `Expected the aggregator to know about codex_personal; instead saw: ${providers
              .map((provider) => provider.instanceId)
              .join(", ")}`,
          );
          assert.strictEqual(
            codexPersonal?.status,
            "error",
            "Real Codex probe against a missing binary should surface as 'error' in the aggregator",
          );
          assert.strictEqual(codexPersonal?.installed, false);
          assert.include(codexPersonal?.message, missingBinary);
          assert.include(codexPersonal?.message, "Settings → Providers → Codex → Binary path");
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("re-probes when settings change the codex binaryPath", () =>
      Effect.gen(function* () {
        const firstMissing = `t3code_codex_first_`;
        const secondMissing = `t3code_codex_second_`;
        const codexInstanceId = ProviderInstanceId.make("codex");
        const disabledRuntimePaths = new Map([
          ["claudeAgent", "t3code_disabled_claude_"],
          ["droid", "t3code_disabled_droid_"],
          ["pi", "t3code_disabled_pi_"],
          ["omp", "t3code_disabled_omp_"],
          ["grok", "t3code_disabled_grok_"],
        ]);
        const defaultInstances =
          ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap(
            DEFAULT_SERVER_SETTINGS,
          );
        const providerInstances = Object.fromEntries(
          Object.entries(defaultInstances).map(([instanceId, instance]) => {
            const disabledRuntimePath = disabledRuntimePaths.get(instanceId);
            return [
              instanceId,
              {
                ...instance,
                enabled: instanceId === codexInstanceId,
                config:
                  instanceId === codexInstanceId
                    ? { ...defaultCodexSettings, binaryPath: firstMissing }
                    : disabledRuntimePath === undefined
                      ? instance.config
                      : {
                          ...(instance.config as Record<string, unknown>),
                          binaryPath: disabledRuntimePath,
                        },
              },
            ];
          }),
        );
        const spawnedCommands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
        let secondSpawnCount = 0;
        const secondProbeStarted = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        const allowLazySettingsStream = yield* Deferred.make<void>();
        const mutableServerSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings(
            deepMerge(encodedDefaultServerSettings, {
              providerInstances,
            }),
          ),
        );
        const serverSettings = {
          ...mutableServerSettings,
          streamChanges: Stream.unwrap(
            Deferred.await(allowLazySettingsStream).pipe(
              Effect.as(mutableServerSettings.streamChanges),
            ),
          ),
        } satisfies ServerSettingsModule.ServerSettingsService["Service"];
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
          Layer.provideMerge(scientAntigravityInstallationLayer),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-provider-registry-",
            }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ModelManifest.layerTest),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ),
          Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
            ChildProcessSpawner.make((command) => {
              if (command._tag !== "StandardCommand") return spawner.spawn(command);
              spawnedCommands.push({ command: command.command, args: [...command.args] });
              if (command.command === secondMissing) secondSpawnCount += 1;
              const beforeSpawn =
                command.command === secondMissing && secondSpawnCount === 2
                  ? Deferred.succeed(secondProbeStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecondProbe)),
                    )
                  : Effect.void;
              return beforeSpawn.pipe(Effect.andThen(spawner.spawn(command)));
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const codexSnapshots = registry.streamChanges.pipe(
            Stream.map((providers) =>
              providers.find((provider) => provider.instanceId === "codex"),
            ),
            Stream.filter((provider): provider is ServerProvider => provider !== undefined),
          );
          const firstError = yield* Stream.toPull(
            codexSnapshots.pipe(Stream.filter((provider) => provider.status === "error")),
          );
          const currentCodex = (yield* registry.getProviders).find(
            (provider) => provider.instanceId === "codex",
          );
          const initialCodex =
            currentCodex?.status === "error" ? currentCodex : (yield* firstError)[0];
          assert.strictEqual(initialCodex?.status, "error");
          assert.strictEqual(initialCodex?.installed, false);
          assert.deepStrictEqual(
            (yield* registry.getProviders)
              .filter((provider) => provider.enabled)
              .map((provider) => provider.instanceId),
            [codexInstanceId],
          );
          // Runtime capability selection and model discovery both use this exact executable.
          assert.deepStrictEqual(
            spawnedCommands.filter((probe) => probe.command === firstMissing),
            [
              { command: firstMissing, args: ["app-server"] },
              { command: firstMissing, args: ["app-server"] },
            ],
          );
          // Disabled managed providers still perform their existing passive runtime
          // qualification. Account for every such probe, without using host binaries.
          assert.deepStrictEqual(
            spawnedCommands
              .filter((probe) => probe.command !== firstMissing)
              .toSorted((left, right) => left.command.localeCompare(right.command)),
            [...disabledRuntimePaths.values()]
              .toSorted()
              .map((command) => ({ command, args: ["--version"] })),
          );
          const initialProbes = [...spawnedCommands];

          const pendingRebuild = yield* Stream.toPull(
            codexSnapshots.pipe(
              Stream.filter((provider) => provider.status === "warning" && !provider.installed),
            ),
          );
          yield* serverSettings.updateProviderInstance({
            operation: "upsert",
            instanceId: codexInstanceId,
            instance: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: { ...defaultCodexSettings, binaryPath: secondMissing },
            },
          });
          yield* Deferred.succeed(allowLazySettingsStream, undefined);

          // Let configured-runtime qualification finish, then hold discovery
          // until the aggregator sees the rebuilt instance's pending snapshot.
          yield* Deferred.await(secondProbeStarted);
          yield* pendingRebuild;
          const rebuiltError = yield* Stream.toPull(
            codexSnapshots.pipe(Stream.filter((provider) => provider.status === "error")),
          );
          yield* Deferred.succeed(releaseSecondProbe, undefined);
          const [reprobedCodex] = yield* rebuiltError;
          assert.deepStrictEqual(spawnedCommands, [
            ...initialProbes,
            { command: secondMissing, args: ["app-server"] },
            { command: secondMissing, args: ["app-server"] },
          ]);
          assert.strictEqual(reprobedCodex?.status, "error");
          assert.strictEqual(reprobedCodex?.installed, false);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("includes unavailable instance snapshots in getProviders", () =>
      Effect.gen(function* () {
        const serverSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings(
            deepMerge(encodedDefaultServerSettings, {
              providerInstances: {
                ...disabledDefaultSlots("codex", "claudeAgent", "cursor", "grok", "opencode"),
                ghost_main: {
                  driver: "ghostDriver",
                  displayName: "A fork-only driver we don't ship",
                  enabled: false,
                  config: { arbitrary: "payload" },
                },
              } as unknown as ContractServerSettings["providerInstances"],
            }),
          ),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
          Layer.provideMerge(scientAntigravityInstallationLayer),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-provider-registry-",
            }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ModelManifest.layerTest),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const providers = yield* registry.getProviders;
          const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

          assert.notStrictEqual(ghost, undefined);
          assert.strictEqual(ghost?.driver, "ghostDriver");
          assert.strictEqual(ghost?.availability, "unavailable");
          assert.strictEqual(Object.hasOwn(ghost ?? {}, "setup"), false);
          assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    const startupSettings = (instanceId?: string) =>
      decodeServerSettings({
        ...encodedDefaultServerSettings,
        providerInstances: {
          // Reserve default IDs without constructing native drivers; these cases test seed ordering.
          ...Object.fromEntries(
            [
              "codex",
              "claudeAgent",
              "cursor",
              "grok",
              "opencode",
              "antigravity",
              "pi",
              "muse",
              "droid",
              "omp",
              "scient",
            ].map((instanceId) => [
              instanceId,
              { driver: "startup-fixture-unregistered", enabled: false },
            ]),
          ),
          ...(instanceId ? { [instanceId]: { driver: "ghostDriver" } } : {}),
        },
      });

    const hydrateDuringSettingsChange = Effect.fnUntraced(function* (input: {
      seed: ContractServerSettings;
      saved: ContractServerSettings;
      current: ContractServerSettings;
      failCurrentRead?: boolean;
    }) {
      const changes = yield* PubSub.unbounded<ContractServerSettings | undefined>();
      const consume = yield* Deferred.make<void>();
      const drained: Array<Deferred.Deferred<void>> = [];
      const startupCommands: Array<string> = [];
      let snapshotReads = 0;
      let readSeed = true;
      let failCurrentRead = false;
      const settings = yield* makeMutableServerSettingsService(input.current);
      const serverSettings = {
        ...settings,
        getSettings: Effect.suspend(() => {
          if (!readSeed) {
            readSeed = true;
            return PubSub.publish(changes, input.saved).pipe(Effect.as(input.seed));
          }
          return failCurrentRead
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  operation: "read-secret",
                  cause: new Error("secret materialization failed"),
                }),
              )
            : settings.getSettings;
        }),
        streamChanges: Stream.empty,
        withSettingsSnapshot: (use, options) =>
          Effect.suspend(() => {
            assert.deepStrictEqual(options, { allowUnresolvedSecrets: true });
            snapshotReads++;
            return settings.withSettingsSnapshot(use);
          }),
        subscribeChanges: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const done = yield* Deferred.make<void>();
          drained.push(done);
          // The terminal marker acknowledges preceding reconciles, including no-op/failed reads.
          return Stream.fromEffectRepeat(
            Deferred.await(consume).pipe(Effect.andThen(PubSub.take(subscription))),
          ).pipe(
            Stream.takeWhile((next): next is ContractServerSettings => next !== undefined),
            Stream.ensuring(Deferred.succeed(done, undefined)),
          );
        }),
      } satisfies ServerSettingsModule.ServerSettingsService["Service"];
      const dependencies = yield* Layer.build(
        Layer.mergeAll(
          AntigravityInstallation.AntigravityInstallation.layer,
          ServerSecretStore.layer,
          OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
        ).pipe(
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-registry-" }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
          Layer.provideMerge(
            layerMockCommandSpawner((command, args) => {
              startupCommands.push(`${command} ${args.join(" ")}`);
              throw new Error(`Startup settings must not launch ${command} ${args.join(" ")}`);
            }),
          ),
        ),
      );
      readSeed = false;
      const services = yield* Layer.build(ProviderInstanceRegistryHydration.layer).pipe(
        Effect.provide(dependencies),
      );
      failCurrentRead = input.failCurrentRead ?? false;
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.succeed(consume, undefined);
      yield* Effect.forEach(drained, Deferred.await);
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry.pipe(
        Effect.provide(services),
      );
      assert.isTrue((yield* registry.listInstances).every((instance) => !instance.enabled));
      assert.isEmpty(yield* registry.listInstances);
      assert.deepStrictEqual(startupCommands, []);
      assert.equal(snapshotReads, input.failCurrentRead ? 1 : 0);
      return (yield* registry.listUnavailable).map(
        (provider): string | undefined => provider.instanceId,
      );
    });

    it.effect("applies a settings change saved while the provider registry starts", () =>
      Effect.gen(function* () {
        const saved = startupSettings("ghost_late");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed: startupSettings(),
          saved,
          current: saved,
        });
        assert.include(unavailable, "ghost_late");
      }),
    );

    it.effect("does not apply a queued settings change older than the registry seed", () =>
      Effect.gen(function* () {
        const seed = startupSettings("ghost_current");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed,
          saved: startupSettings("ghost_stale"),
          current: seed,
        });
        assert.include(unavailable, "ghost_current");
        assert.notInclude(unavailable, "ghost_stale");
      }),
    );

    it.effect(
      "retains the newer registry seed when a queued stale change cannot read current settings",
      () =>
        Effect.gen(function* () {
          const seed = startupSettings("ghost_current");
          const unavailable = yield* hydrateDuringSettingsChange({
            seed,
            saved: startupSettings("ghost_stale"),
            current: seed,
            failCurrentRead: true,
          });
          assert.include(unavailable, "ghost_current");
          assert.notInclude(unavailable, "ghost_stale");
        }),
    );

    it.effect(
      "keeps Cursor disabled and skips its provider probe when its settings use defaults",
      () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providerInstances: disabledDefaultSlots("codex", "grok"),
              }),
            ),
          );
          let cursorSpawned = false;
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const layerProviderRegistry = ProviderRegistry.layer.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
            Layer.provideMerge(scientAntigravityInstallationLayer),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(ServerSecretStore.layer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(layerTestHttpClient),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(ProviderLatestVersions.layer),
            Layer.provideMerge(McpProviderSessions.layer),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(ResetCreditCoordinator.layerTest),
            Layer.provideMerge(
              OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(
              layerMockCommandSpawner((command, args) => {
                if (command === "cursor-agent") {
                  cursorSpawned = true;
                }
                const joined = args.join(" ");
                if (joined === "--version") {
                  return {
                    stdout: `${command} 1.0.0\n`,
                    stderr: "",
                    code: 0,
                  };
                }
                if (joined === "auth status") {
                  return {
                    stdout: '{"authenticated":true}\n',
                    stderr: "",
                    code: 0,
                  };
                }
                throw new Error(`Unexpected args: ${command} ${joined}`);
              }),
            ),
          );
          const runtimeServices = yield* Layer.build(
            Layer.mergeAll(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
              layerProviderRegistry,
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const providers = yield* registry.getProviders;
            const cursorProvider = providers.find(
              (provider) => provider.instanceId === ProviderInstanceId.make("cursor"),
            );

            assert.deepStrictEqual(providers.map((provider) => provider.instanceId).toSorted(), [
              "antigravity",
              "claudeAgent",
              "codex",
              "cursor",
              "droid",
              "grok",
              "muse",
              "omp",
              "opencode",
              "pi",
              "scient",
            ]);
            assert.strictEqual(cursorProvider?.enabled, false);
            assert.strictEqual(cursorProvider?.status, "disabled");
            assert.strictEqual(cursorProvider?.message, "Cursor is disabled in Scient settings.");
            const museProvider = providers.find((provider) => provider.driver === "muse");
            assert.strictEqual(museProvider?.enabled, false);
            assert.strictEqual(museProvider?.status, "disabled");
            assert.strictEqual(cursorSpawned, false);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );

    it.effect("skips codex probes entirely when the provider is disabled", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
          Effect.provide(layerFailingSpawner("spawn codex ENOENT")),
        );
        assert.strictEqual(status.enabled, false);
        assert.strictEqual(status.status, "disabled");
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.message, "Codex is disabled in Scient settings.");
      }),
    );
  });

  describe("checkClaudeProviderStatus", () => {
    it.effect("keeps live usage through a refresh of cached Claude capabilities", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-cache-" });
        const initializationStarted = yield* Deferred.make<void>();
        const usageStarted = yield* Deferred.make<void>();
        const initialization = Promise.withResolvers<ClaudeSdk.SDKControlInitializeResponse>();
        const usage = Promise.withResolvers<ClaudeSdk.SDKControlGetUsageResponse>();
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
          () =>
            ({
              initializationResult: () => {
                Deferred.doneUnsafe(initializationStarted, Effect.void);
                return initialization.promise;
              },
              reloadSkills: async () => ({ skills: [] }),
              usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
                Deferred.doneUnsafe(usageStarted, Effect.void);
                return usage.promise;
              },
            }) satisfies Pick<
              ReturnType<typeof ClaudeSdk.query>,
              | "initializationResult"
              | "reloadSkills"
              | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
            > as unknown as ReturnType<typeof ClaudeSdk.query>,
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

        const instance = yield* ClaudeDriver.create({
          instanceId: ProviderInstanceId.make("claude-usage-cache"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: { ...defaultClaudeSettings, homePath },
        });
        yield* Deferred.await(initializationStarted);
        yield* TestClock.adjust("1 second");
        const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
        initialization.resolve({
          account: { subscriptionType: "max", tokenSource: "oauth" },
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: [],
          models: [],
        });
        yield* Deferred.await(usageStarted);
        yield* TestClock.adjust("1 second");
        usage.resolve({
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: null } },
        } as ClaudeSdk.SDKControlGetUsageResponse);

        const first = yield* instance.snapshot.refresh;
        assert.strictEqual(first.status, "ready");
        const firstWindow = first.usageLimits?.windows[0];
        assert.isDefined(firstWindow);
        assert.strictEqual(firstWindow?.usedPercent, 12);

        yield* TestClock.adjust("1 second");
        const liveCheckedAt = DateTime.formatIso(yield* DateTime.now);
        yield* instance.snapshot.applyUsageLimits({
          checkedAt: liveCheckedAt,
          windows: [{ ...firstWindow!, usedPercent: 95 }],
        });
        const live = yield* instance.snapshot.getSnapshot;
        yield* TestClock.adjust("1 second");
        const refreshCheckedAt = DateTime.formatIso(yield* DateTime.now);
        const refreshed = yield* instance.snapshot.refresh;

        assert.strictEqual(query.mock.calls.length, 1);
        assert.strictEqual(refreshed.checkedAt, refreshCheckedAt);
        assert.deepStrictEqual(refreshed.usageLimits, live.usageLimits);
        assert.strictEqual(refreshed.usageLimits?.checkedAt, liveCheckedAt);
        assert.strictEqual(refreshed.usageLimits?.windows[0]?.usedPercent, 95);
        assert.strictEqual(first.usageLimits?.checkedAt, usageCheckedAt);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestProviderHost.layer({ runBackgroundWork: false }),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-usage-cache-" }),
            IdAllocator.layer,
            McpProviderSessions.layer,
            ResetCreditCoordinator.layerTest,
            ProviderLatestVersions.layer,
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
            Layer.mock(ClaudeAgentSdkQueryRunner)({
              open: () => Effect.die("Usage probing must not start a conversation"),
            }),
          ).pipe(
            Layer.provideMerge(
              layerMockSpawner((args) => {
                if (args.join(" ") === "--version") {
                  return { stdout: "2.1.288\n", stderr: "", code: 0 };
                }
                if (args.join(" ") === "auth status --json") {
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                }
                throw new Error(`Unexpected args: ${args.join(" ")}`);
              }),
            ),
          ),
        ),
      ),
    );

    it.effect("returns ready when claude is installed and authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities(),
          {},
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect.each([
      {
        name: "accepts a healthy claude --version response after 19 seconds",
        answer: Effect.sleep("19 seconds"),
        elapsed: 19_000,
        status: "ready",
        version: "1.0.0",
      },
      {
        name: "bounds a hung claude --version probe",
        answer: Effect.never,
        elapsed: 21_000,
        status: "error",
        version: null,
      },
    ])("$name", ({ answer, elapsed, status: expectedStatus, version }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const commands: Array<ReadonlyArray<string>> = [];
        const statusFiber = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities(),
          {},
        ).pipe(
          Effect.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                const args = (command as unknown as { args: ReadonlyArray<string> }).args;
                commands.push(args);
                if (args.join(" ") === "auth status --json") {
                  return Effect.succeed(
                    mockHandle({
                      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                      stderr: "",
                      code: 0,
                    }),
                  );
                }
                assert.deepStrictEqual(args, ["--version"]);
                return Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                    ...mockHandle({ stdout: "", stderr: "", code: 0 }),
                    exitCode: answer.pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                    stdout: Stream.fromEffect(
                      Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(answer),
                        Effect.as(encoder.encode("1.0.0\n")),
                      ),
                    ),
                  }),
                );
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(elapsed);

        const status = yield* Fiber.join(statusFiber);
        assert.strictEqual(status.status, expectedStatus);
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.version, version);
        if (expectedStatus === "error") {
          assert.include(status.message, "Timed out while running command.");
          assert.deepStrictEqual(commands, [["--version"]]);
        } else {
          assert.strictEqual(status.auth.status, "authenticated");
          assert.deepStrictEqual(commands, [["--version"], ["auth", "status", "--json"]]);
        }
      }),
    );

    it.effect("returns ready and labels Bedrock-backed Claude as authenticated", () =>
      Effect.gen(function* () {
        // Bedrock authenticates via external AWS credentials, so the SDK init
        // reports only `apiProvider` with no subscription or token.
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({ apiProvider: "bedrock" }),
          { CLAUDE_CODE_USE_BEDROCK: "1" },
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "bedrock");
        assert.strictEqual(status.auth.label, "Amazon Bedrock");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("reports a logged-out CLI as unauthenticated", () =>
      Effect.gen(function* () {
        // The CLI auth command is authoritative even when the SDK's
        // capability probe would otherwise produce a catalog.
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          { ANTHROPIC_BASE_URL: "" },
        );
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.auth.status, "unauthenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":false}', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect.each([
      { source: "inherited HTTPS endpoint", baseUrl: "https://proxy.example/api", overrides: [] },
      {
        source: "instance HTTP endpoint overriding Anthropic",
        baseUrl: "https://api.anthropic.com",
        overrides: [
          { name: "ANTHROPIC_BASE_URL", value: "http://localhost:8080", sensitive: false },
        ],
      },
    ])("keeps Claude ready with an empty first-party account: $source", ({ baseUrl, overrides }) =>
      Effect.gen(function* () {
        const environment = yield* mergeProviderInstanceEnvironment(overrides, {
          ANTHROPIC_BASE_URL: baseUrl,
        });
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          environment,
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "customEndpoint");
        assert.strictEqual(status.auth.label, "Custom API endpoint");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect.each([
      "https://api.anthropic.com",
      "https://api.anthropic.com:443",
      "https://api.anthropic.com:8443",
      "openrouter.ai/api",
      "localhost:8080",
      "ftp://proxy.example",
    ])("keeps Claude logged out when the instance endpoint is %s", (baseUrl) =>
      Effect.gen(function* () {
        const environment = yield* mergeProviderInstanceEnvironment(
          [{ name: "ANTHROPIC_BASE_URL", value: baseUrl, sensitive: false }],
          { ANTHROPIC_BASE_URL: "https://proxy.example/api" },
        );
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          environment,
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(status.auth.type, undefined);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps an API key install authenticated when it reports no token source", () =>
      Effect.gen(function* () {
        // `ANTHROPIC_API_KEY` never populates `tokenSource`, so reading that
        // field alone would log the install out.
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "ANTHROPIC_API_KEY",
            apiProvider: "firstParty",
          }),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":true}', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps a third-party backend authenticated without any token source", () =>
      Effect.gen(function* () {
        // Bedrock and Vertex authenticate outside the CLI, so the account
        // payload is empty by design rather than because nobody logged in.
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({ tokenSource: "none", apiProvider: "bedrock" }),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":true}', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps a CLI that says nothing about its account authenticated", () =>
      Effect.gen(function* () {
        // Profile-authenticated installs report no token source at all, and a
        // CLI too old to send an account payload reports nothing whatsoever.
        // Only `tokenSource: "none"` disproves authentication; saying nothing
        // is not the same as saying no.
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities(),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":true}', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns a display label for claude subscription types", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({ subscriptionType: "maxplan" }),
          {},
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "maxplan");
        assert.strictEqual(status.auth.label, "Claude Max Subscription");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("reads banked resets only for subscription logins", () =>
      Effect.gen(function* () {
        const check = (overrides: Partial<TestClaudeCapabilities>) =>
          checkClaudeProviderStatus(
            defaultClaudeSettings,
            () =>
              Effect.succeed({
                email: undefined,
                subscriptionType: undefined,
                tokenSource: undefined,
                apiKeySource: undefined,
                apiProvider: undefined,
                slashCommands: [],
                usage: { rate_limits_available: true, rate_limits: {} },
                ...overrides,
              }),
            overrides.apiProvider === "bedrock" ? { CLAUDE_CODE_USE_BEDROCK: "1" } : {},
            undefined,
            undefined,
            undefined,
            () => Effect.succeed({ availableCount: 2 }),
          );
        const subscription = yield* check({ subscriptionType: "max" });
        const bedrock = yield* check({ apiProvider: "bedrock" });
        assert.deepStrictEqual(subscription.usageLimits?.resetCredits, { availableCount: 2 });
        assert.strictEqual(bedrock.usageLimits?.resetCredits, undefined);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("does not duplicate Claude in full subscription labels", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            subscriptionType: "Claude Max Subscription",
          }),
          {},
        );
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "Claude Max Subscription");
        assert.strictEqual(status.auth.label, "Claude Max Subscription");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("does not duplicate Claude in provider-prefixed subscription names", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            subscriptionType: "Claude Max",
          }),
          {},
        );
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "Claude Max");
        assert.strictEqual(status.auth.label, "Claude Max Subscription");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns claude auth email from initialization result", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({ email: "claude@example.com" }),
          {},
        );
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.email, "claude@example.com");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return {
                stdout:
                  '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("runs Claude status probes with the configured CLAUDE_CONFIG_DIR", () => {
      const claudeConfigDir = "/tmp/t3code-claude-home";
      const recorded = recordingMockSpawnerLayer((args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
        if (joined === "auth status --json")
          return {
            stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
            stderr: "",
            code: 0,
          };
        throw new Error(`Unexpected args: ${joined}`);
      });

      return Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          {
            ...defaultClaudeSettings,
            homePath: claudeConfigDir,
          },
          claudeCapabilities(),
          {},
        );
        assert.strictEqual(status.status, "ready");
        assert.deepStrictEqual(
          recorded.commands.map((command) => command.args),
          [["--version"], ["auth", "status", "--json"]],
        );
        assert.deepStrictEqual(
          recorded.commands.map((command) => command.env?.CLAUDE_CONFIG_DIR),
          [
            (yield* Path.Path).resolve(claudeConfigDir),
            (yield* Path.Path).resolve(claudeConfigDir),
          ],
        );
      }).pipe(Effect.provide(recorded.layer));
    });

    it.effect("includes probed claude slash commands in the provider snapshot", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            subscriptionType: "maxplan",
            slashCommands: [
              {
                name: "review",
                description: "Review a pull request",
                input: { hint: "pr-or-branch" },
              },
            ],
          }),
          {},
        );

        assert.deepStrictEqual(status.slashCommands.slice(1), [
          {
            name: "review",
            description: "Review a pull request",
            input: { hint: "pr-or-branch" },
          },
        ]);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("deduplicates probed claude slash commands by name", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            subscriptionType: "maxplan",
            slashCommands: [
              {
                name: "ui",
                description: "Explore and refine UI",
              },
              {
                name: "ui",
                input: { hint: "component-or-screen" },
              },
            ],
          }),
          {},
        );

        assert.deepStrictEqual(status.slashCommands, [
          COMPACT_SLASH_COMMAND,
          {
            name: "ui",
            description: "Explore and refine UI",
            input: { hint: "component-or-screen" },
          },
        ]);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns an api key label for claude api key auth", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
          { ANTHROPIC_AUTH_TOKEN: "test-external-auth-token" },
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "apiKey");
        assert.strictEqual(status.auth.label, "Claude API Key");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when claude is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities(),
          {},
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.auth.status, "unknown");
        assert.strictEqual(status.message, "Claude Agent CLI (`claude`) was not found on PATH.");
      }).pipe(Effect.provide(layerFailingSpawner("spawn claude ENOENT"))),
    );

    it.effect("returns error when version check fails with non-zero exit code", () => {
      const secretStderr = "Something went wrong: secret-token-value";
      return Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities(),
          {},
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.message, "Claude Agent CLI is installed but failed to run.");
        assert.ok(!(status.message ?? "").includes(secretStderr));
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version")
              return {
                stdout: "",
                stderr: secretStderr,
                code: 1,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      );
    });

    it.effect("returns warning when the Claude initialization result is unavailable", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          noClaudeCapabilities,
          {},
        );
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(
          status.message,
          "Claude is signed in, but Scient could not complete its readiness check.",
        );

        const timedOut = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          () => Effect.fail(new Cause.TimeoutError()),
          // SCIENT-FORK: the external-account path has no first-party CLI sign-in confirmation.
          { ANTHROPIC_API_KEY: "synthetic-timeout-api-key" },
        );
        assert.strictEqual(timedOut.status, "warning");
        assert.strictEqual(timedOut.auth.status, "unknown");
        assert.strictEqual(
          timedOut.message,
          "Timed out after 25s while checking Claude account status.",
        );
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return {
                stdout: '{"loggedIn":true}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("refuses signed-out first-party readiness before SDK initialization", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          () => Effect.die("SDK initialization must not bypass signed-out CLI status"),
          {},
        );
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.installed, true);
        assert.deepStrictEqual(status.auth, { status: "unauthenticated", required: true });
        assert.deepStrictEqual(status.models, []);
        assert.strictEqual(status.message, "Claude is installed but not signed in.");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"loggedIn":false}\n', stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("retains unknown first-party authentication after malformed CLI status", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          () => Effect.die("SDK initialization must not bypass unknown CLI status"),
          {},
        );
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.installed, true);
        assert.deepStrictEqual(status.auth, { status: "unknown", required: true });
        assert.deepStrictEqual(status.models, []);
        assert.strictEqual(status.message, "Could not verify Claude account status.");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status --json")
              return { stdout: '{"authenticated":true}\n', stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });
});
