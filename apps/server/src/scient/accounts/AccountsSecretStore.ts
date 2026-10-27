// @effect-diagnostics nodeBuiltinImport:off -- Random material is generated at the encrypted storage boundary.
import * as NodeCrypto from "node:crypto";
import { Context, Effect, Layer, Option, Redacted, Semaphore } from "effect";
import {
  ServerSecretStore,
  SecretStoreDecodeError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  isSecretAlreadyExistsError,
} from "../../auth/ServerSecretStore.ts";
import { AccountVault, layer as vaultLayer } from "./AccountVault.ts";

export class AccountsSecretStore extends Context.Service<
  AccountsSecretStore,
  ServerSecretStore["Service"]
>()("t3/scient/accounts/AccountsSecretStore") {}

// Invalid UTF-8 distinguishes sealed records from legacy Custom models key text.
const SEALED = 0xff;
const resource = "encrypted secret";

export const makeAccountsSecretStore = Effect.fn("AccountsSecretStore.make")(function* (
  store: ServerSecretStore["Service"],
  vault: AccountVault["Service"],
) {
  const lock = yield* Semaphore.make(1);
  const serialized = <A, E>(effect: Effect.Effect<A, E>) =>
    lock.withPermits(1)(Effect.uninterruptible(effect));
  const seal = Effect.fn("AccountsSecretStore.seal")(function* (name: string, value: Uint8Array) {
    const blob = yield* vault
      .encrypt(name, Redacted.make(value))
      .pipe(
        Effect.mapError(
          () =>
            new SecretStorePersistError({ resource, cause: new Error("Encryption unavailable.") }),
        ),
      );
    return Uint8Array.from([SEALED, ...blob]);
  });
  const read = Effect.fn("AccountsSecretStore.read")(function* (name: string) {
    const stored = yield* store.get(name);
    if (Option.isNone(stored)) return Option.none<Uint8Array>();
    if (stored.value[0] === SEALED) {
      const value = yield* vault
        .decrypt(name, stored.value.subarray(1))
        .pipe(
          Effect.mapError(
            () =>
              new SecretStoreDecodeError({ resource, cause: new Error("Decryption unavailable.") }),
          ),
        );
      return Option.some(Redacted.value(value));
    }
    const legacy = Redacted.make(stored.value);
    yield* store.set(name, yield* seal(name, Redacted.value(legacy)));
    return Option.some(Redacted.value(legacy));
  });
  return AccountsSecretStore.of({
    ...(store.directory === undefined ? {} : { directory: store.directory }),
    get: Effect.fn("AccountsSecretStore.get")((name) => serialized(read(name))),
    set: Effect.fn("AccountsSecretStore.set")((name, value) =>
      serialized(seal(name, value).pipe(Effect.flatMap((blob) => store.set(name, blob)))),
    ),
    create: Effect.fn("AccountsSecretStore.create")((name, value) =>
      serialized(seal(name, value).pipe(Effect.flatMap((blob) => store.create(name, blob)))),
    ),
    getOrCreateRandom: Effect.fn("AccountsSecretStore.getOrCreateRandom")((name, bytes) =>
      serialized(
        Effect.gen(function* () {
          const existing = yield* read(name);
          if (Option.isSome(existing)) return existing.value;
          const value = yield* Effect.try({
            try: () => Redacted.make(Uint8Array.from(NodeCrypto.randomBytes(bytes))),
            catch: () =>
              new SecretStoreRandomGenerationError({
                resource,
                cause: new Error("Random generation unavailable."),
              }),
          });
          const blob = yield* seal(name, Redacted.value(value));
          return yield* store.create(name, blob).pipe(
            Effect.as(Redacted.value(value)),
            Effect.catchIf(isSecretAlreadyExistsError, () =>
              read(name).pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () =>
                      Effect.fail(
                        new SecretStoreDecodeError({
                          resource,
                          cause: new Error("Concurrent secret unavailable."),
                        }),
                      ),
                  }),
                ),
              ),
            ),
          );
        }),
      ),
    ),
    remove: Effect.fn("AccountsSecretStore.remove")((name) => serialized(store.remove(name))),
  });
});

export const layer = Layer.effect(
  AccountsSecretStore,
  Effect.gen(function* () {
    return yield* makeAccountsSecretStore(yield* ServerSecretStore, yield* AccountVault);
  }),
).pipe(Layer.provide(vaultLayer));
