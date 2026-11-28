import { expect, it } from "@effect/vitest";
import { AccountSite, AccountsError, type CustomModelConnection } from "@t3tools/contracts";
import { Effect, Option, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  customModelSecretName,
  resolveCustomModelKey,
  type CustomModelAccountResolver,
} from "../../customModels.ts";
import {
  AccountsState,
  customModelEscrowName,
  decodePrivateJson,
  withStoredAccountsFolded,
} from "./AccountPersistence.ts";
import { restoreCustomModelEscrows } from "./CustomModelKeyEscrow.ts";
import { makeAccountsSecretStore } from "./AccountsSecretStore.ts";
import type { AccountSources } from "./AccountSources.ts";
import { makeHarness, memoryStore, secretEquals, syntheticValue } from "./Accounts.testkit.ts";

const origin = "https://api.example.com:8443";
const legacy: CustomModelConnection = {
  id: "synthetic-connection",
  name: "Synthetic model service",
  credentialId: "legacy-synthetic-slot",
  baseUrl: origin + "/v1",
  protocol: "openai-completions",
  models: [],
};

function migrationFixture(initial = legacy) {
  const storage = memoryStore();
  const key = syntheticValue();
  let connection = initial;
  let hasOldSlot = true;
  let resolveAccount: CustomModelAccountResolver | undefined;
  const invalidations: string[] = [];
  let failAt: "switch" | "retire" | "conflict" | undefined;
  const unavailable = new AccountsError({ reason: "unavailable", message: "Synthetic failure." });
  const catalog: NonNullable<AccountSources["Service"]["modelCatalog"]> = {
    connections: Effect.sync(() => [connection]),
    readLegacy: () => Effect.sync(() => (hasOldSlot ? Redacted.make(key) : undefined)),
    setBinding: (expected, binding) =>
      Effect.suspend(() => {
        if (failAt === "switch") return Effect.fail(unavailable);
        if (
          failAt === "conflict" ||
          (connection !== expected &&
            (connection.accountId !== expected.accountId ||
              connection.credentialId !== expected.credentialId))
        )
          return Effect.succeed(false);
        connection = { ...connection, ...binding };
        return Effect.succeed(true);
      }),
    removeLegacy: () =>
      Effect.suspend(() => {
        if (failAt === "retire") return Effect.fail(unavailable);
        hasOldSlot = false;
        return Effect.void;
      }),
    invalidate: (ids, version) =>
      Effect.sync(() => {
        if (connection.accountId && ids.has(connection.accountId)) invalidations.push(version);
      }),
    installResolver: (resolve) =>
      Effect.sync(() => {
        resolveAccount = resolve;
      }),
  };
  return {
    storage,
    key,
    invalidations,
    start: (migrate = true) =>
      makeHarness({
        storage,
        sourceOverrides: {
          modelCatalog: catalog,
          customModelKeys: Effect.sync(() =>
            connection.accountId
              ? []
              : [
                  {
                    connectionId: connection.id,
                    name: connection.name,
                    origin: new URL(connection.baseUrl).origin,
                  },
                ],
          ),
          transcriptionKeyConsumers: Effect.sync(() =>
            connection.accountId
              ? [
                  {
                    accountId: connection.accountId,
                    kind: "transcription",
                    id: "speech-test",
                    name: "speech-model",
                  },
                ]
              : [],
          ),
        },
      }).pipe(
        Effect.tap(({ service }) =>
          migrate ? (service.migrateCustomModelKeys ?? Effect.void) : Effect.void,
        ),
      ),
    fail: (stage: typeof failAt) => {
      failAt = stage;
    },
    connection: () => connection,
    chooseAccount: (accountId: NonNullable<CustomModelConnection["accountId"]>) => {
      connection = { ...connection, accountId, credentialId: null };
    },
    dropLegacyReference: () => {
      connection = { ...connection, credentialId: null };
    },
    hasOldSlot: () => hasOldSlot,
    resolve: () =>
      resolveCustomModelKey(
        connection,
        {
          ...storage.store,
          get: () =>
            Effect.succeed(hasOldSlot ? Option.some(new TextEncoder().encode(key)) : Option.none()),
        },
        resolveAccount,
      ),
  };
}

it.effect("keeps the legacy reader live until the catalog switch and resumes a staged move", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    f.fail("switch");
    yield* f.start();
    expect(f.connection().accountId).toBeUndefined();
    expect(secretEquals((yield* f.resolve()).apiKey ?? undefined, f.key)).toBe(true);
    f.fail(undefined);
    yield* f.start();
    const switched = f.connection();
    expect(switched.id).toBe(legacy.id);
    expect(switched.credentialId).toBeNull();
    expect(switched.accountId).toBeDefined();
    expect(f.hasOldSlot()).toBe(false);
    expect(secretEquals((yield* f.resolve()).apiKey ?? undefined, f.key)).toBe(true);
    const restarted = yield* f.start();
    expect(f.connection().accountId).toBe(switched.accountId);
    expect((yield* restarted.service.snapshot).accounts).toHaveLength(1);
  }),
);

it.effect("does not resurrect an account removed before retirement succeeds", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    f.fail("retire");
    const { service } = yield* f.start();
    const accountId = f.connection().accountId!;
    expect(f.hasOldSlot()).toBe(true);
    expect(secretEquals((yield* f.resolve()).apiKey ?? undefined, f.key)).toBe(true);
    yield* service.remove(accountId);
    expect((yield* f.resolve()).apiKey).toBeUndefined();
    f.fail(undefined);
    const restarted = yield* f.start();
    expect(f.connection().accountId).toBe(accountId);
    expect(f.hasOldSlot()).toBe(false);
    expect((yield* restarted.service.snapshot).accounts).toHaveLength(0);
    expect((yield* f.resolve()).apiKey).toBeUndefined();
  }),
);

it.effect("rolls back the staged record after a failed compare-and-set", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    f.fail("conflict");
    const { service } = yield* f.start();
    expect(f.connection()).toEqual(legacy);
    expect((yield* service.snapshot).accounts).toHaveLength(0);
    // Journaled, its staged value goes with the sweep.
    yield* TestClock.adjust("1 minute");
    expect([...f.storage.blobs.keys()].some((ref) => ref.startsWith("accounts-value-"))).toBe(
      false,
    );
    expect(secretEquals((yield* f.resolve()).apiKey ?? undefined, f.key)).toBe(true);
  }),
);

it.effect("reports named consumers and invalidates a replaced and removed shared key", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const { service } = yield* f.start();
    const accountId = f.connection().accountId!;
    const snapshot = yield* service.snapshot;
    const account = snapshot.accounts.find((row) => row.accountId === accountId)!;
    expect(snapshot.keyConsumers).toEqual([
      { accountId, kind: "custom-model", id: legacy.id, name: legacy.name },
      { accountId, kind: "transcription", id: "speech-test", name: "speech-model" },
    ]);
    const escrow = customModelEscrowName(legacy.credentialId!);
    expect(f.storage.blobs.has(escrow)).toBe(true);
    const replacement = syntheticValue();
    yield* service.save({
      accountId,
      name: account.name,
      details: account.details,
      secrets: { token: { type: "scient", value: replacement } },
    });
    expect(f.invalidations).toHaveLength(1);
    // The replaced key's escrow is journaled; the minute's sweep deletes it.
    yield* TestClock.adjust("1 minute");
    expect(f.storage.blobs.has(escrow)).toBe(false);
    expect(secretEquals((yield* f.resolve()).apiKey ?? undefined, replacement)).toBe(true);
    expect(
      secretEquals((yield* service.resolveSpeechKey(accountId, origin)).token, replacement),
    ).toBe(true);
    yield* service.remove(accountId);
    expect(f.invalidations).toHaveLength(2);
    expect((yield* f.resolve()).credentialError).toContain("Choose a saved API key");
    expect((yield* service.snapshot).keyConsumers).toEqual(snapshot.keyConsumers);
  }),
);

it.effect("lets a migrated key's old value go when it is replaced, escrow and all", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const { service } = yield* f.start();
    const accountId = f.connection().accountId!;
    const account = (yield* service.snapshot).accounts.find((row) => row.accountId === accountId)!;
    const values = () =>
      [...f.storage.blobs.keys()].filter((name) => name.startsWith("accounts-value-"));
    const before = values();
    yield* service.save({
      accountId,
      name: account.name,
      details: account.details,
      secrets: { token: { type: "scient", value: syntheticValue() } },
    });
    // Journaled in the write that pruned its escrow: the sweep takes it.
    yield* TestClock.adjust("1 minute");
    expect(before.filter((name) => f.storage.blobs.has(name))).toEqual([]);
  }),
);

it.effect("keeps an escrow whose record no longer reads, even with no value named", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const name = "accounts-state";
    const escrow = customModelEscrowName(legacy.credentialId!);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { vault } = yield* f.start();
        expect(f.storage.blobs.has(escrow)).toBe(true);
        // A later build's escrow record: its token lives elsewhere, so this one names no value.
        const stored: { customModelEscrows?: Array<Record<string, unknown>> } = JSON.parse(
          new TextDecoder().decode(
            Redacted.value(yield* vault.decrypt(name, f.storage.blobs.get(name)!)),
          ),
        );
        stored.customModelEscrows = (stored.customModelEscrows ?? []).map(
          ({ tokenRef: _, ...record }) => record,
        );
        f.storage.blobs.set(
          name,
          yield* vault.encrypt(
            name,
            Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
          ),
        );
      }),
    );
    // Two runs: the first holds what didn't read, the second cleans up what is certain.
    yield* Effect.scoped(f.start());
    yield* Effect.scoped(f.start());
    expect(f.storage.blobs.has(escrow)).toBe(true);
  }),
);

/** The stored state, changed as `change` says, as a run of another build would leave it. */
const rewriteStored = (
  f: ReturnType<typeof migrationFixture>,
  change: (stored: {
    customModelEscrows?: Array<Record<string, unknown>>;
    unreadable?: Array<Record<string, unknown>>;
    unreferencedEscrows?: Array<string>;
    escrowJournal?: Array<Record<string, unknown>>;
  }) => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { vault } = yield* f.start();
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(
          Redacted.value(yield* vault.decrypt(name, f.storage.blobs.get(name)!)),
        ),
      );
      change(stored);
      f.storage.blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
    }),
  );

it.effect("keeps an escrow an earlier build held by its token alone, on upgrade", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const escrow = customModelEscrowName(legacy.credentialId!);
    // As round 15 left it: the escrow's record discarded, only its token held.
    yield* rewriteStored(f, (stored) => {
      const row = stored.customModelEscrows![0]!;
      stored.customModelEscrows = [];
      stored.unreadable = [
        ...(stored.unreadable ?? []),
        { list: "customModelEscrows", accountId: row["accountId"], refs: [row["tokenRef"]] },
      ];
    });
    yield* Effect.scoped(f.start());
    yield* Effect.scoped(f.start().pipe(Effect.andThen(TestClock.adjust("2 minutes"))));
    expect(f.storage.blobs.has(escrow)).toBe(true);
  }),
);

it.effect(
  "keeps an escrow a record that didn't read names, when its readable twin's key rotates",
  () =>
    Effect.gen(function* () {
      const f = migrationFixture();
      const escrow = customModelEscrowName(legacy.credentialId!);
      // A second record for the same escrow that no build reads (it names no token).
      yield* rewriteStored(f, (stored) => {
        const { tokenRef: _, ...twin } = stored.customModelEscrows![0]!;
        stored.customModelEscrows = [...stored.customModelEscrows!, twin];
      });
      yield* Effect.scoped(f.start());
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* f.start();
          const accountId = f.connection().accountId!;
          const account = (yield* service.snapshot).accounts.find(
            (row) => row.accountId === accountId,
          )!;
          yield* service.save({
            accountId,
            name: account.name,
            details: account.details,
            secrets: { token: { type: "scient", value: syntheticValue() } },
          });
          yield* TestClock.adjust("2 minutes");
        }),
      );
      expect(f.storage.blobs.has(escrow)).toBe(true);
    }),
);

it.effect("keeps a removed key's escrow for Undo, then drops it when the hour ends", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const { service } = yield* f.start();
    const escrow = customModelEscrowName(legacy.credentialId!);
    expect(f.storage.blobs.has(escrow)).toBe(true);
    yield* service.remove(f.connection().accountId!);
    expect(f.storage.blobs.has(escrow)).toBe(true);
    // Nobody uses Accounts meanwhile: the escrow still goes with the Undo hour.
    yield* TestClock.adjust("61 minutes");
    expect(f.storage.blobs.has(escrow)).toBe(false);
  }),
);

it.effect("installs the resolver before any vault read and migrates on first owner use", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const { service } = yield* f.start(false);
    expect(f.storage.operations).toEqual([]);
    expect(f.connection().accountId).toBeUndefined();
    yield* service.migrateCustomModelKeys!;
    expect(f.connection().accountId).toBeDefined();
    expect(secretEquals((yield* f.resolve()).apiKey ?? undefined, f.key)).toBe(true);
  }),
);

it.effect("flags an unavailable consumer inventory and still removes the key, for Undo", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness({
      sourceOverrides: {
        transcriptionKeyConsumers: Effect.fail(
          new AccountsError({
            reason: "unavailable",
            message: "Synthetic inventory failure.",
          }),
        ),
      },
    });
    const { accountId } = yield* service.save({
      name: "Synthetic",
      details: { kind: "api-key", sites: ["https://api.example.test"], auth: { type: "bearer" } },
      secrets: { token: { type: "scient", value: syntheticValue() } },
    });
    expect((yield* service.snapshot).keyConsumersIncomplete).toBe(true);
    yield* service.remove(accountId);
    expect((yield* service.snapshot).accounts.map((row) => row.accountId)).not.toContain(accountId);
  }),
);

it.effect("keeps Accounts readable by the older site schema and restores only through escrow", () =>
  Effect.gen(function* () {
    const f = migrationFixture({ ...legacy, baseUrl: "http://192.0.2.12:8080/v1" });
    const { vault, store } = yield* f.start();
    const storage = {
      read: (name: string) =>
        Effect.gen(function* () {
          const raw = yield* store.get(name).pipe(Effect.orDie);
          return Option.isSome(raw)
            ? Option.some(yield* vault.decrypt(name, raw.value))
            : Option.none();
        }),
      write: () => Effect.void,
      remove: () => Effect.void,
      exists: () => Effect.succeed(false),
    };
    const saved = yield* storage.read("accounts-state");
    const modelEscrow = customModelEscrowName(legacy.credentialId!);
    expect(f.storage.blobs.has(modelEscrow)).toBe(true);
    expect(f.hasOldSlot()).toBe(false);

    // The previous struct strips unknown fields and validates sites as AccountSite.
    const oldDetails = Schema.Struct({
      kind: Schema.Literal("api-key"),
      sites: Schema.Array(AccountSite),
    });
    const oldReader = Schema.Struct({
      accounts: Schema.Array(Schema.Struct({ summary: Schema.Struct({ details: oldDetails }) })),
    });
    expect((yield* decodePrivateJson(oldReader, Option.getOrThrow(saved))).accounts.length).toBe(1);
    const state = yield* decodePrivateJson(
      AccountsState,
      withStoredAccountsFolded(Option.getOrThrow(saved)),
    );
    const details = state.accounts[0]?.summary.details;
    expect(details?.kind === "api-key" ? details.sites : []).toEqual(["http://192.0.2.12:8080"]);

    const slots = yield* makeAccountsSecretStore(store, vault);
    const withoutAccount = {
      ...f.connection(),
      accountId: undefined,
      credentialId: legacy.credentialId,
    };
    const { accountId: _, ...legacyBinding } = withoutAccount;
    expect((yield* resolveCustomModelKey(legacyBinding, slots)).credentialError).toBeDefined();
    const restored = yield* restoreCustomModelEscrows([f.connection()], state, storage, slots);
    expect(restored.restored).toBe(1);
    const oldSlot = yield* slots.get(customModelSecretName(restored.connections[0]!.credentialId!));
    expect(Option.isSome(oldSlot) && new TextDecoder().decode(oldSlot.value) === f.key).toBe(true);
    const revoked = yield* restoreCustomModelEscrows(
      [f.connection()],
      { ...state, accounts: [] },
      storage,
      slots,
    );
    expect(revoked.restored).toBe(0);
  }),
);

it.effect("discards staging for a connection that lost its legacy reference", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    f.fail("switch");
    yield* f.start();
    expect([...f.storage.blobs.keys()].some((ref) => ref.startsWith("accounts-value-"))).toBe(true);
    f.dropLegacyReference();
    const { service } = yield* f.start();
    yield* service.snapshot;
    yield* TestClock.adjust("1 minute");
    expect([...f.storage.blobs.keys()].some((ref) => ref.startsWith("accounts-value-"))).toBe(
      false,
    );
    expect((yield* service.snapshot).accounts).toEqual([]);
  }),
);

it.effect("continues migrating other connections after one sealed slot fails", () =>
  Effect.gen(function* () {
    const second = { ...legacy, id: "second-model", credentialId: "second-key" };
    let rows: CustomModelConnection[] = [legacy, second];
    const key = syntheticValue();
    const { service } = yield* makeHarness({
      sourceOverrides: {
        modelCatalog: {
          connections: Effect.sync(() => rows),
          readLegacy: (row) =>
            row.id === legacy.id
              ? Effect.fail(
                  new AccountsError({ reason: "unavailable", message: "Synthetic vault error." }),
                )
              : Effect.succeed(Redacted.make(key)),
          setBinding: (expected, binding) =>
            Effect.sync(() => {
              rows = rows.map((row) => (row.id === expected.id ? { ...row, ...binding } : row));
              return true;
            }),
          removeLegacy: () => Effect.void,
          installResolver: () => Effect.void,
        },
      },
    });
    yield* service.migrateCustomModelKeys!;
    expect(rows[0]?.credentialId).toBe(legacy.credentialId);
    expect(rows[1]?.credentialId).toBeNull();
    expect(rows[1]?.accountId).toBeDefined();
  }),
);

it.effect("reports a bound key as unavailable when its sealed value cannot be read", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const { service } = yield* f.start();
    expect((yield* service.snapshot).unavailableCustomModelKeyIds).toEqual([]);
    for (const ref of f.storage.blobs.keys()) {
      if (ref.startsWith("accounts-value-")) f.storage.blobs.delete(ref);
    }
    expect((yield* service.snapshot).unavailableCustomModelKeyIds).toEqual([legacy.id]);
    expect((yield* f.resolve()).credentialError).toBeDefined();
  }),
);

it.effect("keeps an alias row for its other holders, and moves links only within its lineage", () =>
  Effect.gen(function* () {
    for (const changedBinding of [false, true]) {
      const f = migrationFixture();
      const { service } = yield* f.start(false);
      const target = { instanceId: "test-provider", variable: "SYNTHETIC_KEY" } as const;
      const { accountId } = yield* service.save({
        name: "Legacy alias",
        details: { kind: "api-key", sites: [origin], auth: { type: "bearer" } },
        secrets: { token: { type: "custom-model", connectionId: legacy.id } },
      });
      yield* service.setKeyLink(target, accountId);
      if (changedBinding) {
        const replacement = yield* service.save({
          name: "Independent key",
          details: { kind: "api-key", sites: [origin], auth: { type: "bearer" } },
          secrets: { token: { type: "scient", value: syntheticValue() } },
        });
        f.chooseAccount(replacement.accountId);
      }
      yield* service.migrateCustomModelKeys!;
      const after = yield* service.snapshot;
      // Its id stays: a connector or plugin elsewhere may still name it.
      expect(after.accounts.some((entry) => entry.accountId === accountId)).toBe(true);
      if (changedBinding) {
        expect(after.keyLinks).toEqual([{ ...target, accountId }]);
      } else {
        // It holds its own copy of the key, so those holders keep working.
        const { token: kept } = yield* service.resolveSecrets(accountId, ["token"]);
        expect(kept).toBeDefined();
        const migrated = after.accounts.find((entry) => entry.accountId !== accountId)!;
        expect(after.keyLinks).toEqual([{ ...target, accountId: migrated.accountId }]);
        const value = syntheticValue();
        yield* service.save({
          accountId: migrated.accountId,
          name: migrated.name,
          details: migrated.details,
          secrets: { token: { type: "scient", value } },
        });
        const { token } = yield* service.resolveSecrets(
          (yield* service.snapshot).keyLinks![0]!.accountId,
          ["token"],
        );
        expect(secretEquals(token, value)).toBe(true);
      }
    }
  }),
);

it.effect("leaves an escrow no record names on disk: a leak, never a loss", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const escrow = customModelEscrowName(legacy.credentialId!);
    // Its record won't read and names neither its escrow's id nor its token.
    yield* rewriteStored(f, (stored) => {
      stored.customModelEscrows = stored.customModelEscrows!.map(
        ({ legacyId: _, tokenRef: __, ...record }) => record,
      );
    });
    yield* Effect.scoped(f.start());
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { service } = yield* f.start();
        yield* service.migrateCustomModelKeys!;
        yield* TestClock.adjust("2 minutes");
      }),
    );
    expect(f.storage.blobs.has(escrow)).toBe(true);
  }),
);

it.effect("keeps an escrow held for one login held for another, once the first is removed", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const escrow = customModelEscrowName(legacy.credentialId!);
    const other = "acc_00000000-0000-4000-8000-00000000000b";
    // A's escrow, held by name for A too, and B's record of it that won't read (no token).
    yield* rewriteStored(f, (stored) => {
      const row = stored.customModelEscrows![0]!;
      const { tokenRef: _, ...twin } = row;
      stored.customModelEscrows = [...stored.customModelEscrows!, { ...twin, accountId: other }];
      stored.unreadable = [
        ...(stored.unreadable ?? []),
        { list: "customModelEscrows", accountId: row["accountId"], refs: [], escrow },
      ];
    });
    yield* Effect.scoped(f.start());
    // A is removed and its Undo's hour ends; then a run that sweeps.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { service } = yield* f.start();
        yield* service.remove(f.connection().accountId!);
        yield* TestClock.adjust("61 minutes");
      }),
    );
    yield* Effect.scoped(f.start().pipe(Effect.andThen(TestClock.adjust("2 minutes"))));
    expect(f.storage.blobs.has(escrow)).toBe(true);
  }),
);

it.effect("keeps an escrow while a record of it that didn't read names nothing at all", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const escrow = customModelEscrowName(legacy.credentialId!);
    // B's record of A's escrow won't read and names neither the escrow's id nor a token.
    yield* rewriteStored(f, (stored) => {
      const { tokenRef: _, legacyId: __, ...twin } = stored.customModelEscrows![0]!;
      stored.customModelEscrows = [
        ...stored.customModelEscrows!,
        { ...twin, accountId: "acc_00000000-0000-4000-8000-00000000000b" },
      ];
    });
    yield* Effect.scoped(f.start());
    // A is removed and its Undo's hour ends; then a run that sweeps.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { service } = yield* f.start();
        yield* service.remove(f.connection().accountId!);
        yield* TestClock.adjust("61 minutes");
      }),
    );
    yield* Effect.scoped(f.start().pipe(Effect.andThen(TestClock.adjust("2 minutes"))));
    expect(f.storage.blobs.has(escrow)).toBe(true);
  }),
);

it.effect("never sweeps an escrow an earlier build journaled without saying why", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const orphan = customModelEscrowName("orphan");
    f.storage.blobs.set(orphan, new Uint8Array([1]));
    // As round 17 left it: an orphan found on disk, journaled for the sweep.
    yield* rewriteStored(f, (stored) => {
      stored.unreferencedEscrows = [orphan];
    });
    yield* Effect.scoped(f.start().pipe(Effect.andThen(TestClock.adjust("2 minutes"))));
    expect(f.storage.blobs.has(orphan)).toBe(true);
  }),
);

it.effect("opens with a journaled escrow that won't read, quarantined alone and never swept", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const missing = customModelEscrowName("missing");
    const unknown = customModelEscrowName("unknown");
    const journaled = customModelEscrowName("journaled");
    for (const name of [missing, unknown, journaled])
      f.storage.blobs.set(name, new Uint8Array([1]));
    // Two entries with no or an unknown provenance beside one this build wrote.
    yield* rewriteStored(f, (stored) => {
      stored.escrowJournal = [
        { name: missing },
        { name: unknown, provenance: "found-on-disk" },
        { name: journaled, provenance: "decoded-row" },
      ];
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { service } = yield* f.start();
        const accountId = f.connection().accountId!;
        expect((yield* service.snapshot).accounts.map((row) => row.accountId)).toContain(accountId);
        yield* TestClock.adjust("2 minutes");
      }),
    );
    expect([missing, unknown, journaled].map((name) => f.storage.blobs.has(name))).toEqual([
      true,
      true,
      false,
    ]);
  }),
);

it.effect("never sweeps a quarantined escrow, though a valid entry names it too", () =>
  Effect.gen(function* () {
    const f = migrationFixture();
    const escrow = customModelEscrowName("twice");
    f.storage.blobs.set(escrow, new Uint8Array([1]));
    // The same name twice: once with no provenance (quarantined), once as this build writes it.
    yield* rewriteStored(f, (stored) => {
      stored.escrowJournal = [{ name: escrow }, { name: escrow, provenance: "decoded-row" }];
    });
    yield* Effect.scoped(f.start().pipe(Effect.andThen(TestClock.adjust("2 minutes"))));
    yield* Effect.scoped(f.start().pipe(Effect.andThen(TestClock.adjust("2 minutes"))));
    expect(f.storage.blobs.has(escrow)).toBe(true);
  }),
);
