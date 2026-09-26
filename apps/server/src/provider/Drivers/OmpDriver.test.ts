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
import { makeOmpProcessEnvironment, OmpDriver } from "./OmpDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-omp-driver-managed-actions-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
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

it.effect("keeps unrelated server secrets out of the OMP process environment", () =>
  Effect.sync(() => {
    const environment = makeOmpProcessEnvironment(
      [{ name: "OMP_EXPLICIT_SETTING", value: "kept", sensitive: false }],
      {
        PATH: "/usr/bin",
        HOME: "/home/test",
        // A named model-provider credential is intended for the agent, and the
        // host, proxy, and certificate coordinates an agent session needs.
        OPENAI_API_KEY: "intended-for-the-agent",
        HTTPS_PROXY: "http://proxy.internal:3128",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
        XDG_CONFIG_HOME: "/home/test/.config",
        SHELL: "/bin/zsh",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        VIRTUAL_ENV: "/home/test/.venv",
        // Nothing else crosses over.
        UNRELATED_SERVER_SECRET: "must-not-cross",
        SCIENT_SERVER_TOKEN: "must-not-cross",
        NPM_TOKEN: "must-not-cross",
        SOME_OTHER_SERVICE_API_KEY: "must-not-cross",
      },
    );
    expect(environment.OMP_EXPLICIT_SETTING).toBe("kept");
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.HOME).toBe("/home/test");
    expect(environment.OPENAI_API_KEY).toBe("intended-for-the-agent");
    expect(environment.HTTPS_PROXY).toBe("http://proxy.internal:3128");
    expect(environment.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
    expect(environment.XDG_CONFIG_HOME).toBe("/home/test/.config");
    expect(environment.SHELL).toBe("/bin/zsh");
    expect(environment.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(environment.VIRTUAL_ENV).toBe("/home/test/.venv");
    expect(environment.UNRELATED_SERVER_SECRET).toBeUndefined();
    expect(environment.SCIENT_SERVER_TOKEN).toBeUndefined();
    expect(environment.NPM_TOKEN).toBeUndefined();
    expect(environment.SOME_OTHER_SERVICE_API_KEY).toBeUndefined();
  }),
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
