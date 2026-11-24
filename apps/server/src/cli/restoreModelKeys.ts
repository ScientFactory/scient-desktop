// @effect-diagnostics globalJsonInEffect:off -- Preserve settings fields owned by other releases.
import { Effect, Console, FileSystem, Layer, Option, Schema } from "effect";
import { Command, GlobalFlag } from "effect/cli";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { AccountsError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AccountVault from "../scient/accounts/AccountVault.ts";
import * as AccountStorage from "../scient/accounts/AccountPersistence.ts";
import * as LegacySlots from "../scient/accounts/AccountsSecretStore.ts";
import {
  downgradeSettings,
  restoreCustomModelEscrows,
} from "../scient/accounts/CustomModelKeyEscrow.ts";
import { holdServerOwnershipForMaintenance } from "../serverOwnership.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const unavailable = () =>
  new AccountsError({
    reason: "unavailable",
    message: "Could not prepare Custom models downgrade settings.",
  });

const restore = Effect.gen(function* () {
  const { settingsPath, serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  yield* holdServerOwnershipForMaintenance(serverRuntimeStatePath);
  const storage = yield* AccountStorage.AccountPersistence;
  const legacy = yield* LegacySlots.AccountsSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const saved = yield* storage.read("accounts-state");
  if (Option.isNone(saved)) return 0;
  const state = yield* AccountStorage.decodePrivateJson(
    AccountStorage.AccountsState,
    AccountStorage.withStoredAccountsFolded(saved.value),
  );
  if (!state.customModelEscrows?.length) return 0;
  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.mapError(unavailable));
  const { customModels } = yield* Schema.decodeEffect(downgradeSettings)(raw).pipe(
    Effect.mapError(unavailable),
  );
  const result = yield* restoreCustomModelEscrows(customModels.connections, state, storage, legacy);
  if (result.restored) {
    const settings = JSON.parse(raw) as Record<string, unknown>;
    yield* writeFileStringAtomically({
      filePath: settingsPath,
      contents: JSON.stringify(
        { ...settings, customModels: { ...customModels, connections: result.connections } },
        null,
        2,
      ),
    }).pipe(Effect.mapError(unavailable));
  }
  return result.restored;
});

export const restoreModelKeysCommand = Command.make("restore-model-keys", authLocationFlags).pipe(
  Command.withDescription(
    "Restore unchanged Custom models keys before downgrading. Stop the server first.",
  ),
  Command.withHandler(
    Effect.fn("cli.restoreModelKeys")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const count = yield* restore.pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(AccountStorage.layer, LegacySlots.layer).pipe(
            Layer.provide(AccountVault.layer),
            Layer.provide(ServerSecretStore.layer),
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(`Restored ${count} Custom models key slots.`);
    }),
  ),
);
