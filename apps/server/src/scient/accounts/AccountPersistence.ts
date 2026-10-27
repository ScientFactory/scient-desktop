import {
  AccountsError,
  AccountSummary,
  AccountWriteStore,
  BrowserProfileRecord,
  AccountActivityEntry,
  OnePasswordStatus,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { AccountVault } from "./AccountVault.ts";

export const StoredAccount = Schema.Struct({
  summary: AccountSummary,
  pendingCopies: Schema.optional(Schema.Record(Schema.String, Schema.Array(AccountWriteStore))),
  values: Schema.Record(
    Schema.String,
    Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
  ),
});
export type StoredAccount = typeof StoredAccount.Type;
export const AccountsState = Schema.Struct({
  format: Schema.Literal(1),
  agentAccess: Schema.Boolean,
  accounts: Schema.Array(StoredAccount),
  profiles: Schema.Array(BrowserProfileRecord),
  onePassword: Schema.optional(
    Schema.Union([
      Schema.Struct({
        mode: Schema.Literal("service-account"),
        tokenRef: Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
      }),
      Schema.Struct({ mode: Schema.Literal("desktop"), accountName: Schema.String }),
    ]),
  ),
  onePasswordStatus: OnePasswordStatus,
});
export type AccountsState = typeof AccountsState.Type;
export const emptyState: AccountsState = {
  format: 1,
  agentAccess: true,
  accounts: [],
  profiles: [],
  onePasswordStatus: { state: "not-connected" },
};
export const Activity = Schema.Array(AccountActivityEntry);

export class AccountPersistence extends Context.Service<
  AccountPersistence,
  {
    readonly read: (
      name: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<Uint8Array>>, AccountsError>;
    readonly write: (
      name: string,
      value: Redacted.Redacted<Uint8Array>,
    ) => Effect.Effect<void, AccountsError>;
    readonly remove: (name: string) => Effect.Effect<void, AccountsError>;
  }
>()("t3/scient/accounts/AccountPersistence") {}

export const layer = Layer.effect(
  AccountPersistence,
  Effect.gen(function* () {
    const store = yield* ServerSecretStore;
    const vault = yield* AccountVault;
    const unavailable = () =>
      new AccountsError({
        reason: "unavailable",
        message: "Scient Accounts data could not be persisted.",
      });
    return AccountPersistence.of({
      read: Effect.fn("AccountPersistence.read")(function* (name) {
        const stored = yield* store.get(name).pipe(Effect.mapError(unavailable));
        return Option.isNone(stored)
          ? Option.none()
          : Option.some(yield* vault.decrypt(name, stored.value));
      }),
      write: Effect.fn("AccountPersistence.write")(function* (name, value) {
        yield* store
          .set(name, yield* vault.encrypt(name, value))
          .pipe(Effect.mapError(unavailable));
      }),
      remove: Effect.fn("AccountPersistence.remove")((name) =>
        store.remove(name).pipe(Effect.mapError(unavailable)),
      ),
    });
  }),
);

export const decodePrivateJson = <A, E>(
  schema: Schema.Codec<A, E>,
  bytes: Redacted.Redacted<Uint8Array>,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(
    new TextDecoder().decode(Redacted.value(bytes)),
  ).pipe(
    Effect.mapError(
      () =>
        new AccountsError({
          reason: "unavailable",
          message: "Stored Scient Accounts data is unreadable.",
        }),
    ),
  );
export const encodePrivateJson = <A, E>(schema: Schema.Codec<A, E>, value: A) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((json) => Redacted.make(new TextEncoder().encode(json))),
    Effect.mapError(
      () =>
        new AccountsError({
          reason: "unavailable",
          message: "Scient Accounts data could not be encoded.",
        }),
    ),
  );
