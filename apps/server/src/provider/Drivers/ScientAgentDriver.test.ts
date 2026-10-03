// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  ManagedScientAgentRuntime,
  resolveScientAgentArtifactPolicy,
} from "@scientfactory/provider-runtime";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as OmpExecutableGate from "../omp/OmpExecutableGate.ts";
import { ScientAgentDriver } from "./ScientAgentDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJsonPath = Schema.decodeSync(Schema.fromJsonString(Schema.String));

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-scient-driver-managed-actions-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
  Layer.provideMerge(Layer.succeed(HostProcessArchitecture, "arm64")),
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
  Effect.die("Scient Agent driver test must not spawn a process"),
);

it.layer(testLayer)("ScientAgentDriver", (it) => {
  it.effect("exposes managed runtime actions on the provider instance", () =>
    Effect.gen(function* () {
      const instance = yield* ScientAgentDriver.create({
        instanceId: ProviderInstanceId.make("scient-managed-actions"),
        displayName: "Scient test",
        enabled: false,
        environment: [],
        config: ScientAgentDriver.defaultConfig(),
      });
      expect(instance.managedRuntimeActions).toBeDefined();
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.connection?.runtime).toMatchObject({ source: "missing", actions: [] });
      expect(snapshot.connection?.runtime?.message).toContain("release");
      expect(snapshot.connection?.methods).toEqual([]);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "launches a durably selected managed binary without a current catalog release",
    () =>
      Effect.gen(function* () {
        const { baseDir } = yield* ServerConfig;
        const marker = NodePath.join(baseDir, "launched-paths.jsonl");
        const artifact = {
          ...resolveScientAgentArtifactPolicy({ platform: "darwin", arch: "arm64" })!,
          version: "0.1.0",
          url: "https://github.com/ScientFactory/scient-agent/releases/download/v0.1.0/scient-agent-darwin-arm64",
          checksum: { algorithm: "sha256" as const, digest: "a".repeat(64) },
          size: 1,
          catalogRevision: "scient:0.1.0:driver-fixture",
        };
        const script = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${encodeJson(marker)}, JSON.stringify(process.argv[1]) + "\\n");
if (process.argv.includes("--runtime-info")) {
  process.stdout.write(JSON.stringify({product:"scient-agent",version:"0.1.0",upstream:{name:"oh-my-pi",version:"18.4.8"},rpcProtocolVersions:[1,2]}) + "\\n");
  process.exit(0);
}
process.stderr.write("No models available.\\n");
process.exit(1);
`;
        const runtime = new ManagedScientAgentRuntime(baseDir, {
          download: async ({ destination }) => {
            NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
            NodeFS.writeFileSync(destination, "fixture");
          },
          verify: async () => undefined,
          materialize: async ({ destination, executablePath }) => {
            NodeFS.mkdirSync(destination, { recursive: true });
            const binary = NodePath.join(destination, executablePath);
            NodeFS.writeFileSync(binary, script, { mode: 0o755 });
            return binary;
          },
          smoke: async () => undefined,
        });
        yield* Effect.promise(() =>
          runtime.install({ artifact, signal: new AbortController().signal }),
        );
        const instance = yield* ScientAgentDriver.create({
          instanceId: ProviderInstanceId.make("scient-managed-launch"),
          displayName: "Scient test",
          enabled: true,
          environment: [],
          config: ScientAgentDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshotForCwd!(baseDir);
        expect(snapshot.version).toBe("0.1.0");
        expect(snapshot.status).toBe("warning");
        expect(snapshot.message).toContain("has no models yet");
        expect(snapshot.connection?.runtime).toMatchObject({
          source: "scient_managed",
          managedVersion: "0.1.0",
        });
        const launched = NodeFS.readFileSync(marker, "utf8")
          .trim()
          .split("\n")
          .map((line) => decodeJsonPath(line));
        expect(launched.length).toBeGreaterThan(0);
        expect(new Set(launched)).toEqual(new Set([runtime.launchPath(artifact)]));
      }).pipe(Effect.scoped),
  );
});
