import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AccountsError, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import type { RemovedAgent } from "./scient/accounts/removedAgentKeys.ts";

const layerSettings = ServerSettingsModule.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-removed-agent-keys-" })),
  ),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("removed agent keys", (it) => {
  const instanceId = ProviderInstanceId.make("codex_work");
  const add = (service: ServerSettingsModule.ServerSettingsService["Service"]) =>
    service.updateProviderInstance({
      operation: "create",
      instanceId,
      instance: {
        driver: ProviderDriverKind.make("codex"),
        environment: [{ name: "OPENAI_API_KEY", value: "sk-typed", sensitive: true }],
      },
    });
  const token = (settings: { providerInstances: Record<string, RemovedAgent["instance"]> }) =>
    settings.providerInstances[instanceId]?.environment?.[0]?.value;

  it.effect("hands a removed agent's stored keys to the keeper before deleting them", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const seen: Array<RemovedAgent> = [];
      yield* service.setRemovedAgentKeeper!((removed) =>
        Effect.sync(() => {
          seen.push(...removed);
        }),
      );
      yield* add(service);
      yield* service.updateProviderInstance({ operation: "remove", instanceId });
      assert.deepEqual(
        seen.map((agent) => [
          agent.instanceId,
          token({ providerInstances: { [instanceId]: agent.instance } }),
        ]),
        [[instanceId, "sk-typed"]],
      );
    }).pipe(Effect.provide(layerSettings)),
  );

  it.effect("leaves the agent and its key in place when the keeper fails", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.setRemovedAgentKeeper!(() =>
        Effect.fail(new AccountsError({ reason: "unavailable", message: "Accounts is locked." })),
      );
      yield* add(service);
      const error = yield* service
        .updateProviderInstance({ operation: "remove", instanceId })
        .pipe(Effect.flip);
      assert.equal(error.operation, "keep-removed-agent-keys");
      assert.equal(
        error.message,
        "Scient couldn't keep this agent's keys in Accounts, so it wasn't removed. Accounts is locked.",
      );
      assert.equal(token(yield* service.getSettings), "sk-typed");
    }).pipe(Effect.provide(layerSettings)),
  );
});
