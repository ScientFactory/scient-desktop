import { it, expect } from "@effect/vitest";
import { AccountsError } from "@t3tools/contracts";
import { Effect, Redacted } from "effect";
import {
  makeHarness,
  memoryStore,
  secretEquals,
  syntheticValue,
  website,
} from "./AccountsTestkit.ts";
import { AccountsState, decodePrivateJson, encodePrivateJson } from "./AccountPersistence.ts";
import { onePasswordWriteFailure } from "./AccountSources.ts";
import { planSecretStores } from "./copyPlan.ts";

it.effect(
  "compares resolved passwords without returning them and isolates origins, usernames and profiles",
  () =>
    Effect.gen(function* () {
      const password = syntheticValue();
      const changed = syntheticValue();
      const { service } = yield* makeHarness({
        sourceOverrides: { keychain: () => Effect.succeed(Redacted.make(password)) },
      });
      const input = {
        ...website(),
        details: {
          kind: "website" as const,
          sites: ["https://example.com"],
          username: "synthetic",
          profileId: "work",
        },
        secrets: {
          password: { type: "keychain" as const, service: "Synthetic", account: "synthetic" },
        },
      };
      const { accountId } = yield* service.save(input);
      const capture = {
        origin: "https://example.com",
        username: "synthetic",
        password,
        profileId: "work",
      };
      expect(yield* service.matchSignIn(capture)).toEqual({ result: "same", accountId });
      expect(yield* service.matchSignIn({ ...capture, password: changed })).toEqual({
        result: "password-changed",
        accountId,
      });
      for (const overrides of [
        { origin: "https://other.example.com" },
        { username: "another" },
        { profileId: "personal" },
      ])
        expect(yield* service.matchSignIn({ ...capture, ...overrides })).toEqual({ result: "new" });
    }),
);

it("plans selected stores once, preserving existing copy identities on updates", () => {
  const details = website().details;
  expect(
    planSecretStores(details, "password", undefined, [
      { type: "scient" },
      { type: "keychain" },
      { type: "1password", vaultId: "vault" },
    ]),
  ).toEqual([
    { type: "scient" },
    { type: "keychain", service: "Scient: example.com", account: "synthetic-user" },
    { type: "1password", vaultId: "vault" },
  ]);
  expect(
    planSecretStores(
      details,
      "password",
      {
        source: { type: "scient" },
        copies: [{ type: "1password", reference: "op://vault/item/password" }],
      },
      [{ type: "1password", vaultId: "vault" }],
    ),
  ).toEqual([{ type: "scient" }, { type: "1password", reference: "op://vault/item/password" }]);
  expect(planSecretStores(details, "password", undefined, [{ type: "keychain" }])).toHaveLength(1);
});

it.effect(
  "keeps the durable Scient value on copy denial, remembers the vault until reconnect, and propagates updates to every copy",
  () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      let denied = true;
      let creates = 0;
      let keychain: Redacted.Redacted<string> | undefined;
      let remote: Redacted.Redacted<string> | undefined;
      const sourceOverrides = {
        keychain: () =>
          keychain
            ? Effect.succeed(keychain)
            : Effect.fail(new AccountsError({ reason: "unavailable", message: "Unavailable" })),
        writeKeychain: (_source: unknown, value: Redacted.Redacted<string>) =>
          Effect.sync(() => {
            keychain = value;
          }),
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            vaults: [{ id: "vault", name: "Synthetic vault", readOnly: false }],
            resolve: () =>
              remote
                ? Effect.succeed(remote)
                : Effect.fail(new AccountsError({ reason: "unavailable", message: "Unavailable" })),
            createLogin: (input: { value: Redacted.Redacted<string> }) =>
              Effect.suspend(() => {
                creates++;
                if (denied)
                  return Effect.fail(
                    new AccountsError({ reason: "denied", message: "Synthetic denial" }),
                  );
                remote = input.value;
                return Effect.succeed({
                  type: "1password" as const,
                  reference: "op://vault/item/password",
                });
              }),
            write: (_reference: string, value: Redacted.Redacted<string>) =>
              Effect.sync(() => {
                remote = value;
              }),
          }),
      };
      const { service } = yield* makeHarness({ storage, sourceOverrides });
      yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
      const password = syntheticValue();
      const input = website(password);
      const saved = yield* service.save({
        ...input,
        secrets: {
          password: {
            type: "scient",
            value: password,
            saveTo: [
              { type: "scient" },
              { type: "keychain" },
              { type: "1password", vaultId: "vault" },
            ],
          },
        },
      });
      expect(saved.warnings).toEqual(["Vault Synthetic vault is read-only."]);
      expect(
        secretEquals(
          (yield* service.resolveSecrets(saved.accountId, ["password"])).password,
          password,
        ),
      ).toBe(true);
      yield* service.test(saved.accountId);
      expect((yield* service.snapshot).accounts[0]?.status).toBe("needs-attention");
      const restarted = (yield* makeHarness({ storage, sourceOverrides })).service;
      expect((yield* restarted.snapshot).stores.onePassword).toMatchObject({
        vaults: [{ readOnly: true }],
      });
      const next = syntheticValue();
      yield* restarted.save({ ...website(next), accountId: saved.accountId });
      expect(creates).toBe(1);
      expect(secretEquals(keychain, next)).toBe(true);
      denied = false;
      yield* restarted.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
      yield* restarted.save({ ...website(next), accountId: saved.accountId });
      expect(creates).toBe(2);
      expect(secretEquals(remote, next)).toBe(true);
      const rotated = syntheticValue();
      yield* restarted.save({ ...website(rotated), accountId: saved.accountId });
      expect(secretEquals(keychain, rotated) && secretEquals(remote, rotated)).toBe(true);
      expect((yield* restarted.snapshot).accounts[0]?.secrets.password?.copies).toHaveLength(2);
      const relinked = syntheticValue();
      keychain = Redacted.make(relinked);
      yield* restarted.save({
        ...website(),
        accountId: saved.accountId,
        secrets: {
          password: { type: "keychain", service: "Scient: example.com", account: "synthetic-user" },
        },
      });
      expect(
        secretEquals(
          (yield* restarted.resolveSecrets(saved.accountId, ["password"])).password,
          relinked,
        ) && secretEquals(remote, relinked),
      ).toBe(true);
      expect((yield* restarted.snapshot).accounts[0]?.secrets.password?.source.type).toBe(
        "keychain",
      );
      yield* restarted.remove(saved.accountId);
      expect(secretEquals(keychain, relinked) && secretEquals(remote, relinked)).toBe(true);
    }),
);

it("marks permission failures without mistaking an unavailable 1Password connection for a read-only vault", () => {
  expect(
    onePasswordWriteFailure(new Error("You do not have permission to execute this argument."))
      .reason,
  ).toBe("denied");
  expect(onePasswordWriteFailure(new Error("Network unavailable")).reason).toBe("unavailable");
});

it.effect(
  "persists and rotates credential field names that collide with Object prototype members",
  () =>
    Effect.gen(function* () {
      const field: string = "constructor";
      const storage = memoryStore();
      const { service, vault } = yield* makeHarness({ storage });
      const input = {
        name: "Synthetic CLI",
        details: {
          kind: "cli-login" as const,
          tool: "other" as const,
          variables: [{ name: field, secret: true }],
        },
        secrets: { [field]: { type: "scient" as const, value: syntheticValue() } },
      };
      const { accountId } = yield* service.save(input);
      const state = yield* decodePrivateJson(
        AccountsState,
        yield* vault.decrypt("accounts-state", storage.blobs.get("accounts-state")!),
      );
      const legacy = {
        ...state,
        accounts: state.accounts.map(({ pendingCopies: _, ...account }) => account),
      };
      yield* storage.store.set(
        "accounts-state",
        yield* vault.encrypt("accounts-state", yield* encodePrivateJson(AccountsState, legacy)),
      );
      const restarted = (yield* makeHarness({ storage })).service;
      const value = syntheticValue();
      yield* restarted.save({
        ...input,
        accountId,
        secrets: { [field]: { type: "scient" as const, value } },
      });
      expect(
        secretEquals((yield* restarted.resolveSecrets(accountId, [field]))[field], value),
      ).toBe(true);
    }),
);

it.effect("compares a current linked password after an earlier autofill cached its old value", () =>
  Effect.gen(function* () {
    let value = syntheticValue();
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            resolve: () => Effect.sync(() => Redacted.make(value)),
          }),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    const { accountId } = yield* service.save({
      ...website(),
      secrets: { password: { type: "1password", reference: "op://vault/item/password" } },
    });
    yield* service.fillValues(accountId, "https://example.com");
    value = syntheticValue();
    expect(
      yield* service.matchSignIn({
        origin: "https://example.com",
        username: "synthetic-user",
        password: value,
      }),
    ).toEqual({ result: "same", accountId });
  }),
);
