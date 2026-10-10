// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as OmpExecutableGate from "../omp/OmpExecutableGate.ts";
import { OmpDriver } from "./OmpDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../ProviderEventLoggers.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-omp-driver-managed-actions-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ProviderContinuationRequests.layer),
  Layer.provideMerge(OmpExecutableGate.layer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
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

  it.effect("removes extension files a crashed server left, and keeps current ones", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig;
      // Last changed in 2001 (seconds since the epoch), long before this server started.
      const crashed = 1_000_000_000;
      const write = (file: string, mtime?: number) => {
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, "{}");
        if (mtime) NodeFS.utimesSync(file, mtime, mtime);
      };
      const extensions = NodePath.join(stateDir, "omp", "extensions");
      const staleProcess = NodePath.join(extensions, "process-stale");
      write(NodePath.join(staleProcess, "scient-custom-models.bootstrap.json"), crashed);
      write(NodePath.join(staleProcess, "scient-custom-models.mjs"), crashed);
      NodeFS.utimesSync(staleProcess, crashed, crashed);
      // A live process of this server: written after it started.
      const liveProcess = NodePath.join(extensions, `process-${process.pid}-live`);
      write(NodePath.join(liveProcess, "scient-custom-models.mjs"));
      const session = NodePath.join(stateDir, "omp-sessions", "0123abcd");
      const staleBootstrap = NodePath.join(session, "scient-extension-old.bootstrap.json");
      const staleExtension = NodePath.join(session, "scient-extension-old.mjs");
      const liveBootstrap = NodePath.join(session, "scient-extension-new.bootstrap.json");
      const transcript = NodePath.join(session, "2001-01-01_session.jsonl");
      write(staleBootstrap, crashed);
      write(staleExtension, crashed);
      write(liveBootstrap);
      write(transcript, crashed);

      yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp-sweep"),
        displayName: "OMP test",
        enabled: false,
        environment: [],
        config: OmpDriver.defaultConfig(),
      });

      expect(NodeFS.existsSync(staleProcess)).toBe(false);
      expect(NodeFS.existsSync(staleBootstrap)).toBe(false);
      expect(NodeFS.existsSync(staleExtension)).toBe(false);
      expect(NodeFS.existsSync(liveProcess)).toBe(true);
      expect(NodeFS.existsSync(liveBootstrap)).toBe(true);
      // The conversation itself is not an extension file.
      expect(NodeFS.existsSync(transcript)).toBe(true);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("keeps another live server's extension files, however old", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig;
      const old = 1_000_000_000;
      // The parent of this test runner is alive and is not this process.
      const other = process.ppid;
      const processDirectory = NodePath.join(stateDir, "omp", "extensions", `process-${other}-x`);
      NodeFS.mkdirSync(processDirectory, { recursive: true });
      NodeFS.utimesSync(processDirectory, old, old);
      const session = NodePath.join(stateDir, "omp-sessions", "4567cdef");
      NodeFS.mkdirSync(session, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(session, ".session.lock"), `${other}:nonce:token\n`);
      const extension = NodePath.join(session, "scient-extension-other.mjs");
      NodeFS.writeFileSync(extension, "export default () => {};");
      NodeFS.utimesSync(extension, old, old);

      yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp-sweep-other"),
        displayName: "OMP test",
        enabled: false,
        environment: [],
        config: OmpDriver.defaultConfig(),
      });

      expect(NodeFS.existsSync(processDirectory)).toBe(true);
      expect(NodeFS.existsSync(extension)).toBe(true);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("offers no update action, even for a fresh maintenance resolution", () =>
    Effect.gen(function* () {
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp-fresh-maintenance"),
        displayName: "OMP test",
        enabled: false,
        environment: [],
        config: OmpDriver.defaultConfig(),
      });
      for (const options of [undefined, { fresh: true }]) {
        const capabilities = yield* instance.snapshot.resolveMaintenance(options);
        expect(capabilities.update).toBeNull();
        expect(capabilities.packageName).toBeNull();
      }
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});
