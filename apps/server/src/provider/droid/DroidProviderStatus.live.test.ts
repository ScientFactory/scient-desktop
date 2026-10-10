// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DroidSettings, ProviderInstanceId } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import * as DateTime from "effect/DateTime";
import { HttpClient, HttpClientResponse } from "effect/http";
import { beforeAll } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { DroidDriver } from "../Drivers/DroidDriver.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "../ModelManifest.ts";
import { factoryFixtureBody, qualifyDroidTestBinary } from "./DroidLiveTestPreflight.ts";
import { layerConfigConsistentTestProviderHost } from "../testUtils/providerHost.ts";

const binary = process.env.SCIENT_DROID_TEST_BINARY;
beforeAll(() => qualifyDroidTestBinary(binary), 10_000);

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const providerDependenciesLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-droid-status-live-" }),
  ServerSettingsService.layerTest({ providerHealthRefreshInterval: Duration.millis(300) }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
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
        updatedAt: EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: () => Effect.succeed(true),
    shouldRunOpportunisticWork: Effect.succeed(true),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
    ),
  ),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ProviderContinuationRequests.layer),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layer = layerConfigConsistentTestProviderHost.pipe(
  Layer.provideMerge(providerDependenciesLayer),
);

const sessionFiles = (home: string): ReadonlyArray<string> => {
  const directory = NodePath.join(home, ".factory", "sessions");
  return NodeFS.existsSync(directory)
    ? NodeFS.readdirSync(directory, { recursive: true })
        .map(String)
        .filter((name) => name.endsWith(".jsonl"))
    : [];
};

// Verified against Droid 0.229.0: a full probe starts one Droid session, which
// skill discovery reuses; periodic checks start none.
it.live.skipIf(!binary)(
  "real Droid: one session per full probe and none from periodic checks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-status-" });
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(NodePath.join(home, ".factory"), { recursive: true });
      // Every Factory request goes to this stub; no account or hosted inference is used.
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeHttp.createServer((request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(factoryFixtureBody(request.url));
          }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
              }),
          ),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const environment = Object.entries({
        HOME: home,
        FACTORY_PROFILE_DIR: NodePath.join(home, "profile"),
        FACTORY_API_KEY: "fk-fixture",
        FACTORY_API_BASE_URL: origin,
        FACTORY_TELEMETRY_INGEST_BASE_URL: origin,
        FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
        FACTORY_DISABLE_KEYRING: "true",
      }).map(([name, value]) => ({ name, value, sensitive: false }));
      const instance = yield* DroidDriver.create({
        instanceId: ProviderInstanceId.make("droid_status_live"),
        displayName: undefined,
        environment,
        enabled: true,
        config: decodeDroidSettings({ enabled: true, binaryPath: binary! }),
      });
      // The startup probe.
      yield* Effect.gen(function* () {
        while ((yield* instance.snapshot.getSnapshot).status !== "ready")
          yield* Effect.sleep("50 millis");
      }).pipe(Effect.timeout("45 seconds"));
      expect(sessionFiles(home)).toHaveLength(1);
      // Many periodic checks at 300ms.
      yield* Effect.sleep("2500 millis");
      expect(sessionFiles(home)).toHaveLength(1);
      expect((yield* instance.snapshot.getSnapshot).status).toBe("ready");
      // An explicit refresh is one more full probe: one more session, skills included.
      const refreshed = yield* instance.snapshot.refresh;
      expect(refreshed.status).toBe("ready");
      expect(sessionFiles(home)).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  120_000,
);
