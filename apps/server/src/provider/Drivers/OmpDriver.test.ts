// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OmpDriver } from "./OmpDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-omp-driver-managed-actions-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('{"tag_name":"v18.3.1"}\n', {
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      ),
    ),
  ),
);

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("OMP driver test must not spawn a process"),
);

it.layer(testLayer)("OmpDriver", (it) => {
  it.effect("exposes managed runtime actions on the provider instance", () =>
    Effect.gen(function* () {
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp-managed-actions"),
        displayName: "OMP test",
        enabled: false,
        environment: [],
        config: OmpDriver.defaultConfig(),
      });
      expect(instance.managedRuntimeActions).toBeDefined();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("fresh maintenance resolution carries the OMP release candidate", () =>
    Effect.gen(function* () {
      const binary = process.env.OMP_QUALIFY_BINARY;
      if (!binary) return;
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp-fresh-maintenance"),
        displayName: "OMP test",
        enabled: true,
        environment: [],
        config: OmpSettings.make({
          enabled: true,
          binaryPath: binary,
          customModels: [],
          homePath: "",
          profile: "",
        }),
      });
      const capabilities = yield* instance.snapshot.resolveMaintenance({ fresh: true });
      expect(capabilities.latestVersion).toBe("18.3.1");
      expect(capabilities.update?.args).toEqual(["update", "--stable"]);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});
