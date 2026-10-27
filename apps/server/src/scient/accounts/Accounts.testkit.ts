// @effect-diagnostics nodeBuiltinImport:off -- Tests generate synthetic material and keep it in memory.
import * as NodeCrypto from "node:crypto";
import { AccountsError, BUILT_IN_BROWSER_PROFILES } from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { ServerSecretStore, SecretStorePersistError } from "../../auth/ServerSecretStore.ts";
import { AccountVault, makeAccountVault, type AccountKeychain } from "./AccountVault.ts";
import * as AccountPersistence from "./AccountPersistence.ts";
import { AccountSources } from "./AccountSources.ts";
import { AccountsService } from "./AccountsService.ts";
import * as AccountsServiceLive from "./AccountsServiceLive.ts";

export const syntheticValue = () => NodeCrypto.randomUUID();
const unavailable = () =>
  new AccountsError({ reason: "unavailable", message: "Synthetic source unavailable." });
export const noKeychain: AccountKeychain = {
  read: () => Effect.fail(unavailable()),
  write: () => Effect.fail(unavailable()),
};

export const memoryStore = () => {
  const blobs = new Map<string, Uint8Array>();
  const operations: string[] = [];
  let failWrite: string | undefined;
  const store = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(blobs.get(name)?.slice())),
    set: (name, value) =>
      Effect.suspend(() => {
        if (name === failWrite)
          return Effect.fail(
            new SecretStorePersistError({
              resource: "synthetic record",
              cause: new Error("Synthetic disk failure"),
            }),
          );
        operations.push(`set:${name}`);
        blobs.set(name, value.slice());
        return Effect.void;
      }),
    create: (name, value) =>
      Effect.suspend(() => {
        if (blobs.has(name))
          return Effect.fail(
            new SecretStorePersistError({
              resource: "synthetic record",
              cause: new Error("Already exists"),
            }),
          );
        operations.push(`create:${name}`);
        blobs.set(name, value.slice());
        return Effect.void;
      }),
    getOrCreateRandom: (name, count) =>
      Effect.sync(() => {
        const value = blobs.get(name) ?? Uint8Array.from(NodeCrypto.randomBytes(count));
        blobs.set(name, value);
        return value.slice();
      }),
    remove: (name) =>
      Effect.sync(() => {
        operations.push(`remove:${name}`);
        blobs.delete(name);
      }),
  });
  return {
    store,
    blobs,
    operations,
    failWritesTo: (name: string | undefined) => {
      failWrite = name;
    },
  };
};

export const makeHarness = Effect.fn("AccountsTestkit.make")(function* (
  options: {
    readonly storage?: ReturnType<typeof memoryStore>;
    readonly sourceOverrides?: Partial<AccountSources["Service"]>;
  } = {},
) {
  const storage = options.storage ?? memoryStore();
  const vault = yield* makeAccountVault(storage.store, "/synthetic/accounts-test", noKeychain);
  const sources = AccountSources.of({
    platform: "linux",
    profiles: Effect.succeed(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id)),
    customModelKeys: Effect.succeed([]),
    keychain: () => Effect.fail(unavailable()),
    writeKeychain: () => Effect.fail(unavailable()),
    customModel: () => Effect.fail(unavailable()),
    onePassword: () => Effect.fail(unavailable()),
    candidates: () => Effect.succeed({ listed: false, candidates: [] }),
    ...options.sourceOverrides,
  });
  const context = yield* Layer.build(
    AccountsServiceLive.layer.pipe(
      Layer.provide(AccountPersistence.layer),
      Layer.provide(Layer.succeed(AccountSources, sources)),
      Layer.provide(Layer.succeed(AccountVault, vault)),
      Layer.provide(Layer.succeed(ServerSecretStore, storage.store)),
    ),
  );
  return { service: Context.get(context, AccountsService), vault, ...storage };
});

export const website = (value = syntheticValue()) => ({
  name: "Synthetic website",
  details: { kind: "website" as const, sites: ["example.com"], username: "synthetic-user" },
  secrets: { password: { type: "scient" as const, value } },
});
export const secretEquals = (left: Redacted.Redacted<string> | undefined, right: string) =>
  left !== undefined && Redacted.value(left) === right;

export const layer = Layer.effect(
  AccountsService,
  makeHarness().pipe(Effect.map(({ service }) => service)),
);
