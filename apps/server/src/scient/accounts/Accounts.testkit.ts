import { makeCliPasswordStores } from "./CliPasswordStores.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Tests generate synthetic material and keep it in memory.
import * as NodeCrypto from "node:crypto";
import {
  AccountId,
  AccountsError,
  BUILT_IN_BROWSER_PROFILES,
  defaultAccountControls,
  type AccountActivityEntry,
  type AccountHandoff,
  type AccountSaveInput,
  type AccountsSnapshot,
  type AccountSummary,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Redacted, Stream } from "effect";
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
    passwordStores: makeCliPasswordStores({ env: {}, platform: "linux", commonDirectories: [] }),
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

/** A stand-in AccountsService that records what the agent tools ask of it. */
export function fakeAccounts(
  options: {
    accounts?: ReadonlyArray<AccountSummary>;
    profiles?: ReadonlyArray<BrowserProfileRecord>;
    agentAccess?: boolean;
    denied?: boolean;
    values?: Readonly<Record<string, string>>;
    filledTab?: { accountId: AccountId; url: string };
  } = {},
) {
  const handoffs = new Map<string, AccountHandoff>();
  const cancelled = new Set<string>();
  const uses: Array<Omit<AccountActivityEntry, "at" | "decision">> = [];
  const calls: string[] = [];
  const checks: Array<{ accountId: AccountId; state: string; message?: string | undefined }> = [];
  const accounts = [...(options.accounts ?? [])];
  const saves: Array<AccountSaveInput> = [];
  const unsupported = Effect.fail(
    new AccountsError({
      reason: "unsupported",
      message: "Not available in the synthetic account store.",
    }),
  );
  const service = AccountsService.of({
    setHandoff: (entry) =>
      Effect.sync(() => {
        handoffs.set(entry.handoffId, entry);
      }),
    removeHandoff: (id) =>
      Effect.sync(() => {
        handoffs.delete(id);
        cancelled.delete(id);
      }),
    handoffCancelled: (id) => Effect.sync(() => cancelled.has(id)),
    setPaperQueue: () => Effect.void,
    showHandoff: () => unsupported,
    cancelHandoff: (id) =>
      Effect.sync(() => {
        cancelled.add(id);
      }),
    passwordStore: () => unsupported,
    snapshot: Effect.sync(() => ({ accounts }) as unknown as AccountsSnapshot),
    changes: Stream.empty,
    save: (input) =>
      Effect.sync(() => {
        saves.push(input);
        const accountId =
          input.accountId ?? AccountId.make(`acc_saved_${String(saves.length).padStart(4, "0")}`);
        const index = accounts.findIndex((account) => account.accountId === accountId);
        const saved: AccountSummary = {
          accountId,
          name: input.name,
          details: input.details,
          secrets: { token: { source: { type: "scient" } } },
          controls: accounts[index]?.controls ?? defaultAccountControls(input.details.kind),
          status: "ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        if (index === -1) accounts.push(saved);
        else accounts[index] = saved;
        return { accountId };
      }),
    remove: () => unsupported,
    test: () => unsupported,
    recordCheck: (accountId, check) =>
      Effect.sync(() => {
        checks.push({ accountId, ...check });
        const index = accounts.findIndex((account) => account.accountId === accountId);
        if (index !== -1)
          accounts[index] = {
            ...accounts[index]!,
            signIn: { ...check, at: "2026-01-01T00:00:00.000Z" },
          };
      }),
    setControls: () => unsupported,
    setAgentAccess: () => unsupported,
    updateProfile: () => unsupported,
    removeProfile: () => unsupported,
    chooseProfile: () => unsupported,
    mainFilled: () => unsupported,
    mainSignedOut: () => unsupported,
    googleSessionsSeen: () => unsupported,
    setCodeSources: () => unsupported,
    setKeyLink: () => Effect.void,
    respondApproval: () => unsupported,
    activity: () => Effect.succeed([]),
    keychainCandidates: () => unsupported,
    connectOnePassword: () => unsupported,
    disconnectOnePassword: unsupported,
    importPasswords: () => unsupported,
    fillValues: () => unsupported,
    filledTab: () => Effect.succeed(options.filledTab),
    matchSignIn: () => unsupported,
    forSession: () =>
      Effect.succeed({
        agentAccess: options.agentAccess ?? true,
        accounts,
        profiles: options.profiles ?? [],
      }),
    authorize: (_scope, target, action) =>
      Effect.sync(() => {
        calls.push(`authorize:${target.type}:${action}`);
        return options.denied
          ? { decision: "denied" as const, reason: "off" as const }
          : { decision: "allowed" as const };
      }),
    resolveBound: () => unsupported,
    listBindable: () => unsupported,
    resolveSecrets: (_id, fields) =>
      Effect.sync(() => {
        calls.push("resolve");
        return Object.fromEntries(
          fields.flatMap((field) =>
            options.values?.[field] === undefined
              ? []
              : [[field, Redacted.make(options.values[field])]],
          ),
        );
      }),
    recordUse: (entry) =>
      Effect.sync(() => {
        uses.push(entry);
      }),
  });
  return { service, calls, uses, handoffs, cancelled, saves, checks };
}
