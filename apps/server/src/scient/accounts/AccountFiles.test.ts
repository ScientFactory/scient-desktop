// @effect-diagnostics nodeBuiltinImport:off -- Verify synthetic owner-only on-disk storage.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { makeAccountVault, AccountVault } from "./AccountVault.ts";
import * as AccountPersistence from "./AccountPersistence.ts";
import { noKeychain, syntheticValue } from "./AccountsTestkit.ts";

it.effect("persists encrypted account files and a fallback key with owner-only permissions", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const vault = yield* makeAccountVault(store, config.stateDir, noKeychain);
    const context = yield* Layer.build(
      AccountPersistence.layer.pipe(
        Layer.provide(Layer.succeed(AccountVault, vault)),
        Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
      ),
    );
    const persistence = Context.get(context, AccountPersistence.AccountPersistence);
    const value = new TextEncoder().encode(syntheticValue());
    yield* persistence.write("accounts-state", Redacted.make(value));
    const stored = yield* store.get("accounts-state");
    expect(Option.isSome(stored) && Buffer.from(stored.value).includes(Buffer.from(value))).toBe(
      false,
    );
    const restarted = yield* makeAccountVault(store, config.stateDir, noKeychain);
    expect(yield* restarted.protection).toBe("file");
    const decoded = Option.isSome(stored)
      ? yield* restarted.decrypt("accounts-state", stored.value)
      : undefined;
    expect(
      decoded !== undefined && Buffer.from(Redacted.value(decoded)).equals(Buffer.from(value)),
    ).toBe(true);
    if ((yield* HostProcess.Platform) !== "win32") {
      const mode = (path: string) =>
        Effect.promise(async () => (await NodeFSP.stat(path)).mode & 0o777);
      expect(yield* mode(config.secretsDir)).toBe(0o700);
      expect(yield* mode(NodePath.join(config.secretsDir, "accounts-master-key.bin"))).toBe(0o600);
      expect(yield* mode(NodePath.join(config.secretsDir, "accounts-state.bin"))).toBe(0o600);
    }
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-accounts-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
