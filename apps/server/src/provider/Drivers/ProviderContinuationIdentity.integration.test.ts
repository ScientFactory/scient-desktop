import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as FileSystem from "effect/FileSystem";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import { CodexAppServerClientFactory } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ClaudeAgentSdkQueryRunner } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CursorAgentSdkRunner } from "@t3tools/provider-cursor/server/CursorAgentSdk";
import { Agent } from "@cursor/sdk";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PtyAdapter } from "@t3tools/shared/PtyAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OmpExecutableGate from "../omp/OmpExecutableGate.ts";
import { PiDriver } from "@t3tools/provider-pi/server";
import { OmpDriver } from "./OmpDriver.ts";
import { ScientAgentDriver } from "./ScientAgentDriver.ts";
import { DroidDriver } from "./DroidDriver.ts";
import { LegacyAntigravityDriver } from "./LegacyAntigravityDriver.ts";
import { layerConfigConsistentTestProviderHost } from "../testUtils/providerHost.ts";

const noProcess = () => Effect.die("Continuation identity must not start a provider process");
const baseLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-native-continuation-identity-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const providerDependenciesLayer = baseLayer.pipe(
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ProviderContinuationRequests.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("Continuation identity must not read real Keychain credentials"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(CursorSdk.CursorSdk, {
      Agent: new Proxy(Agent, {
        get() {
          throw new Error("Continuation identity must not call the real SDK");
        },
      }),
      createAgentPlatform: () => {
        throw new Error("Continuation identity must not create a real SDK platform");
      },
    }),
  ),
  Layer.provideMerge(OmpExecutableGate.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(baseLayer))),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(CodexAppServerClientFactory)({ open: noProcess })),
  Layer.provideMerge(Layer.mock(ClaudeAgentSdkQueryRunner)({ open: noProcess })),
  Layer.provideMerge(Layer.mock(CursorAgentSdkRunner)({ open: noProcess })),
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
    Layer.mock(BackgroundPolicy)({ shouldRunScopeWork: () => Effect.succeed(false) }),
  ),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, HttpClient.make(noProcess))),
  Layer.provideMerge(Layer.succeed(PtyAdapter, { spawn: noProcess })),
  Layer.provideMerge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(noProcess)),
  ),
);
const testLayer = layerConfigConsistentTestProviderHost.pipe(
  Layer.provideMerge(providerDependenciesLayer),
);

const input = (kind: string, ordinal: number) => ({
  instanceId: ProviderInstanceId.make(`${kind}-continuation-${ordinal}`),
  displayName: undefined,
  enabled: false,
  environment: [],
});
const factories = [
  {
    kind: "cursor",
    create: (ordinal: number) =>
      CursorDriver.create({ ...input("cursor", ordinal), config: CursorDriver.defaultConfig() }),
  },
  {
    kind: "pi",
    create: (ordinal: number) =>
      PiDriver.create({ ...input("pi", ordinal), config: PiDriver.defaultConfig() }),
  },
  {
    kind: "omp",
    create: (ordinal: number) =>
      OmpDriver.create({ ...input("omp", ordinal), config: OmpDriver.defaultConfig() }),
  },
  {
    kind: "scient",
    create: (ordinal: number) =>
      ScientAgentDriver.create({
        ...input("scient", ordinal),
        config: ScientAgentDriver.defaultConfig(),
      }),
  },
  {
    kind: "droid",
    create: (ordinal: number) =>
      DroidDriver.create({ ...input("droid", ordinal), config: DroidDriver.defaultConfig() }),
  },
  {
    kind: "antigravity",
    create: (ordinal: number) =>
      LegacyAntigravityDriver.create({
        ...input("antigravity", ordinal),
        config: LegacyAntigravityDriver.defaultConfig(),
      }),
  },
];

it.layer(testLayer)("Configured native continuation identity", (it) => {
  it.effect("Codex continuation follows shared native history across private auth overlays", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const create = (ordinal: number, shared: string, shadowHomePath = "") =>
        CodexDriver.create({
          ...input("codex", ordinal),
          config: { ...CodexDriver.defaultConfig(), homePath: `${root}/${shared}`, shadowHomePath },
        });
      const direct = yield* create(1, "shared");
      const overlay = yield* create(2, "shared", `${root}/shadow`);
      const independent = yield* create(3, "independent");
      assert.deepEqual(overlay.continuationIdentity, direct.continuationIdentity);
      assert.equal(direct.continuationIdentity.continuationKey, `codex:home:${root}/shared`);
      assert.notEqual(
        independent.continuationIdentity.continuationKey,
        direct.continuationIdentity.continuationKey,
      );
      assert.equal(overlay.orchestrationAdapter.instanceId, overlay.instanceId);
      assert.equal(
        (yield* overlay.snapshot.getSnapshot).continuation?.groupKey,
        overlay.continuationIdentity.continuationKey,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "Claude continuation follows the effective native config home and honors explicit override",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const inherited = `${root}/inherited`;
        const create = (ordinal: number, homePath: string) =>
          ClaudeDriver.create({
            ...input("claude", ordinal),
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: inherited, sensitive: false }],
            config: { ...ClaudeDriver.defaultConfig(), homePath },
          });
        const ambient = yield* create(1, "");
        const explicitSame = yield* create(2, inherited);
        const independent = yield* create(3, `${root}/independent`);
        assert.deepEqual(explicitSame.continuationIdentity, ambient.continuationIdentity);
        assert.equal(ambient.continuationIdentity.continuationKey, `claude:home:${inherited}`);
        assert.notEqual(
          independent.continuationIdentity.continuationKey,
          ambient.continuationIdentity.continuationKey,
        );
        assert.equal(explicitSame.orchestrationAdapter.instanceId, explicitSame.instanceId);
        assert.equal(
          (yield* ambient.snapshot.getSnapshot).continuation?.groupKey,
          ambient.continuationIdentity.continuationKey,
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(
    factories.map((factory) => ({
      caseTitle: `${factory.kind} confines continuation to the configured instance across recreation`,
      factory,
    })),
  )("$caseTitle", ({ factory }) =>
    Effect.gen(function* () {
      const initial = yield* factory.create(1);
      const peer = yield* factory.create(2);
      const recreated = yield* factory.create(1);
      assert.deepEqual(initial.continuationIdentity, {
        driverKind: initial.driverKind,
        continuationKey: `${factory.kind}:instance:${initial.instanceId}`,
      });
      assert.deepEqual(recreated.continuationIdentity, initial.continuationIdentity);
      assert.notEqual(
        peer.continuationIdentity.continuationKey,
        initial.continuationIdentity.continuationKey,
      );
      assert.equal(initial.orchestrationAdapter.instanceId, initial.instanceId);
      assert.equal(peer.orchestrationAdapter.instanceId, peer.instanceId);
      assert.equal(
        (yield* initial.snapshot.getSnapshot).continuation?.groupKey,
        initial.continuationIdentity.continuationKey,
      );
      assert.equal(
        (yield* peer.snapshot.getSnapshot).continuation?.groupKey,
        peer.continuationIdentity.continuationKey,
      );
    }).pipe(Effect.scoped),
  );
});
