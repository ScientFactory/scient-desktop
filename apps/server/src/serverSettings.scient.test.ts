import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AccountId,
  AccountsError,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  type AccountKeyLink,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { fakeAccounts } from "./scient/accounts/Accounts.testkit.ts";
import { makeAccountKeyLinks } from "./scient/accounts/keyLinks.ts";
import { makeKeptAgentKeys } from "./scient/accounts/keptAgentKeys.ts";
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

  it.effect("keeps a failed removal's key links, and drops them once a removal commits", () => {
    let failRemove = false;
    const layerSecret = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        remove: (name: string) =>
          failRemove
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: "provider environment secret",
                  cause: new Error("Disk full"),
                }),
              )
            : store.remove(name),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const layerFailingRemove = ServerSettingsModule.layer.pipe(
      Layer.provide(layerSecret),
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-removed-agent-links-" }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const linked: AccountKeyLink = {
        instanceId,
        variable: "OPENAI_API_KEY",
        accountId: AccountId.make("acc_linked01"),
      };
      let keyLinks: ReadonlyArray<AccountKeyLink> = [linked];
      const dropped = yield* Deferred.make<void>();
      const fake = fakeAccounts();
      const accounts = {
        ...fake.service,
        snapshot: fake.service.snapshot.pipe(Effect.map((snapshot) => ({ ...snapshot, keyLinks }))),
        setKeyLink: (target: Pick<AccountKeyLink, "instanceId" | "variable">) =>
          Effect.sync(() => {
            keyLinks = keyLinks.filter(
              (link) => link.instanceId !== target.instanceId || link.variable !== target.variable,
            );
          }).pipe(Effect.andThen(Deferred.succeed(dropped, undefined)), Effect.asVoid),
      };
      yield* add(service);
      yield* makeKeptAgentKeys(accounts);
      yield* makeAccountKeyLinks(accounts);
      failRemove = true;
      const error = yield* service
        .updateProviderInstance({ operation: "remove", instanceId })
        .pipe(Effect.flip);
      assert.notEqual(error.operation, "keep-removed-agent-keys");
      assert.equal(token(yield* service.getSettings), "sk-typed");
      assert.deepEqual(keyLinks, [linked]);
      failRemove = false;
      yield* service.updateProviderInstance({ operation: "remove", instanceId });
      yield* Deferred.await(dropped);
      assert.deepEqual(keyLinks, []);
    }).pipe(Effect.scoped, Effect.provide(layerFailingRemove));
  });
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("guest links default", (it) => {
  // Scient turned guest links on by default; an older default-off file has no key and turns on.
  it.effect("stores turning guest links off, and nothing while they are on", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue((yield* service.getSettings).guestSharingEnabled);
      yield* service.updateSettings({ guestSharingEnabled: false });
      assert.include(yield* fs.readFileString(config.settingsPath), '"guestSharingEnabled": false');
      yield* service.updateSettings({ guestSharingEnabled: true });
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "guestSharingEnabled");
    }).pipe(Effect.provide(layerSettings)),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "continue threads after restarts",
  (it) => {
    const projectOff = ProjectId.make("project-off");
    const projectOther = ProjectId.make("project-other");
    // Scient shipped this off; the first load after it became the default turns it on once.
    it.effect("turns it on once for everyone, including where it was switched off", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            continueThreadsAfterServerUpdate: false,
            projectSettingsOverrides: {
              [projectOff]: { continueThreadsAfterServerUpdate: false },
              [projectOther]: {
                continueThreadsAfterServerUpdate: false,
                threadTitleInstructions: "Use ticket ids",
              },
            },
          }),
        );
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.isTrue(settings.continueThreadsAfterServerUpdate);
        assert.isTrue(settings.continueThreadsAfterServerUpdateTurnedOn);
        assert.deepEqual(settings.projectSettingsOverrides, {
          [projectOther]: { threadTitleInstructions: "Use ticket ids" },
        });
        const stored = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.isUndefined(stored.continueThreadsAfterServerUpdate);
        assert.deepEqual(stored.projectSettingsOverrides, {
          [projectOther]: { threadTitleInstructions: "Use ticket ids" },
        });
        // Switching it off now is kept, with the record that the switch-on already ran.
        yield* service.updateSettings({ continueThreadsAfterServerUpdate: false });
        const off = JSON.parse(yield* fs.readFileString(config.settingsPath));
        assert.isFalse(off.continueThreadsAfterServerUpdate);
        assert.isTrue(off.continueThreadsAfterServerUpdateTurnedOn);
      }).pipe(Effect.provide(layerSettings)),
    );

    it.effect("keeps it off when it is switched off after it was turned on", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            continueThreadsAfterServerUpdate: false,
            continueThreadsAfterServerUpdateTurnedOn: true,
            projectSettingsOverrides: {
              [projectOff]: { continueThreadsAfterServerUpdate: false },
            },
          }),
        );
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.isFalse(settings.continueThreadsAfterServerUpdate);
        assert.deepEqual(settings.projectSettingsOverrides, {
          [projectOff]: { continueThreadsAfterServerUpdate: false },
        });
        yield* service.updateSettings({ continueThreadsAfterServerUpdate: true });
        yield* service.updateSettings({ continueThreadsAfterServerUpdate: false });
        assert.isFalse((yield* service.getSettings).continueThreadsAfterServerUpdate);
        assert.include(
          yield* fs.readFileString(config.settingsPath),
          '"continueThreadsAfterServerUpdate": false',
        );
      }).pipe(Effect.provide(layerSettings)),
    );

    it.effect("is on for a new install", () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        assert.isTrue((yield* service.getSettings).continueThreadsAfterServerUpdate);
      }).pipe(Effect.provide(layerSettings)),
    );
  },
);
