import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderHostLive from "../../provider/ProviderHostLive.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeAcpRegistryManagedRuntimeActions } from "./AcpRegistryManagedRuntimeActions.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);

const registryUrl = "https://registry.test/registry.json";
const archiveUrl = "https://registry.test/example-agent.bin";
const bytes = new TextEncoder().encode("#!/bin/sh\necho verified\n");
const agent = {
  id: "example-agent",
  name: "Example Agent",
  version: "1.2.3",
  description: "Synthetic removal fixture",
  distribution: {
    binary: {
      "linux-x86_64": {
        archive: archiveUrl,
        cmd: "bin/example-agent",
        sha256: "9c76ec33e2b9013ce136f3bf6750ce60f6a40def87b4a724c89c7d55af27b4f7",
      },
    },
  },
};

const layerSettings = ServerSettings.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "scient-acp-removal-integration-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const layerHost = ProviderHostLive.layer.pipe(
  Layer.provideMerge(layerSettings),
  Layer.provide(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);
const layer = Layer.mergeAll(
  layerHost,
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Architecture, "x64"),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            request.url === archiveUrl
              ? bytes
              : JSON.stringify({ version: "1.0.0", agents: [agent] }),
          ),
        ),
      ),
    ),
  ),
);

it.live(
  "removes a reviewed ACP installation under the real settings lock and releases writes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-acp-removal-fixture-" });
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        registryUrl,
      });
      const config = decodeSettings({
        agentId: agent.id,
        distribution: "binary",
      });
      const environment = decodeEnvironment([]);
      const ownerId = ProviderInstanceId.make("registry-owner");
      const siblingId = ProviderInstanceId.make("registry-sibling");
      const entry = { driver: ProviderDriverKind.make("acpRegistry"), config, environment };
      yield* catalog.resolve(config, root);
      const installed = yield* catalog.inspect(config);
      if (installed.status !== "ready" || !installed.installation)
        return yield* Effect.die("Expected fixture installation");
      const outside = `${root}/unrelated-tool`;
      yield* fs.writeFileString(outside, "unrelated bytes");
      yield* serverSettings.updateSettings({
        providerInstances: { [ownerId]: entry, [siblingId]: entry },
      });
      const actions = yield* makeAcpRegistryManagedRuntimeActions({
        instanceId: ownerId,
        settings: config,
        instanceEnvironment: environment,
        environment: {},
        cwd: root,
      }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

      const shared = yield* actions.plan("remove").pipe(Effect.flip);
      expect(shared.message).toContain("Another configured provider uses this registry");
      expect(yield* fs.exists(installed.installation.executablePath)).toBe(true);
      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: siblingId });
      const reviewed = yield* actions.plan("remove");
      yield* actions.run("remove", reviewed.catalogRevision, () => Effect.void);
      expect(yield* fs.exists(installed.installation.installRoot)).toBe(false);
      expect(yield* fs.readFileString(outside)).toBe("unrelated bytes");

      const next = yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Projects" });
      expect(next.addProjectBaseDirectory).toBe("~/Projects");
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(layer)),
);
