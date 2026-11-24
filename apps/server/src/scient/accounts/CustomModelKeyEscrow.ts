import {
  AccountsError,
  CustomModelsSettings,
  type CustomModelConnection,
} from "@t3tools/contracts";
import { Effect, Option, Redacted, Schema } from "effect";
import type { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { customModelSecretName } from "../../customModels.ts";
import {
  type AccountPersistence,
  type AccountsState,
  customModelEscrowName,
} from "./AccountPersistence.ts";

const failure = () =>
  new AccountsError({ reason: "unavailable", message: "Could not restore the Custom models key." });

export const downgradeSettings = Schema.Struct({ customModels: CustomModelsSettings }).pipe(
  Schema.fromJsonString,
);

/** Activate the original legacy slot only for an unchanged, still-owned binding. */
export const restoreCustomModelEscrows = Effect.fn("Accounts.restoreCustomModelEscrows")(function* (
  connections: ReadonlyArray<CustomModelConnection>,
  state: AccountsState,
  persistence: Pick<AccountPersistence["Service"], "read">,
  legacy: ServerSecretStore["Service"],
) {
  let restored = 0;
  const updated: CustomModelConnection[] = [];
  for (const connection of connections) {
    const escrow = state.customModelEscrows?.find(
      (entry) =>
        entry.connectionId === connection.id &&
        entry.accountId === connection.accountId &&
        entry.baseUrl === connection.baseUrl &&
        entry.protocol === connection.protocol &&
        (!connection.credentialId || connection.credentialId === entry.legacyId),
    );
    const account = state.accounts.find(({ summary }) => summary.accountId === escrow?.accountId);
    const details = account?.summary.details;
    if (
      !escrow ||
      account?.values.token !== escrow.tokenRef ||
      details?.kind !== "api-key" ||
      details.speechOnly ||
      (escrow.protocol === "anthropic-messages"
        ? details.auth.type !== "header" || details.auth.name.toLowerCase() !== "x-api-key"
        : details.auth.type !== "bearer") ||
      account.summary.secrets.token?.source.type !== "scient" ||
      !URL.canParse(escrow.baseUrl) ||
      !details.sites.includes(new URL(escrow.baseUrl).origin)
    ) {
      updated.push(connection);
      continue;
    }
    const sealed = yield* persistence.read(customModelEscrowName(escrow.legacyId));
    const current = yield* persistence.read(escrow.tokenRef);
    if (Option.isNone(sealed) || Option.isNone(current)) return yield* failure();
    const bytes = Redacted.value(sealed.value);
    const currentBytes = Redacted.value(current.value);
    if (currentBytes.length !== bytes.length || !currentBytes.every((byte, i) => byte === bytes[i]))
      return yield* failure();
    const name = customModelSecretName(escrow.legacyId);
    const existing = yield* legacy.get(name).pipe(Effect.mapError(failure));
    if (Option.isSome(existing)) {
      if (
        existing.value.length !== bytes.length ||
        !existing.value.every((byte, i) => byte === bytes[i])
      )
        return yield* failure();
    } else {
      yield* legacy.create(name, bytes).pipe(Effect.mapError(failure));
    }
    updated.push({ ...connection, credentialId: escrow.legacyId });
    restored++;
  }
  return { connections: updated, restored };
});
