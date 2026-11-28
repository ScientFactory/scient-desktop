import { makeCliPasswordStores } from "./CliPasswordStores.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Tests generate synthetic material and keep it in memory.
import * as NodeCrypto from "node:crypto";
import {
  AccountId,
  AuthSessionId,
  RpcClientId,
  type ClientActivityLease,
  type HostPowerSnapshot,
  AccountsError,
  BUILT_IN_BROWSER_PROFILES,
  defaultAccountControls,
  type AccountActivityEntry,
  type AccountHandoff,
  type AccountNeedsYou,
  type BrowserProfileId,
  type AccountSignInAttempt,
  type AccountSignInEnd,
  type AccountSaveInput,
  type AccountsSnapshot,
  type AccountSummary,
  type BrowserProfileChoices,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { Context, DateTime, Deferred, Effect, Layer, Option, Redacted, Ref, Stream } from "effect";
import { ServerSecretStore, SecretStorePersistError } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ClientActivityLeases } from "./clientLeases.ts";
import {
  AccountVault,
  makeAccountKeychain,
  makeAccountVault,
  type AccountKeychain,
} from "./AccountVault.ts";
import * as AccountPersistence from "./AccountPersistence.ts";
import { AccountSources } from "./AccountSources.ts";
import { AccountsService } from "./AccountsService.ts";
import * as AccountsServiceLive from "./AccountsServiceLive.ts";
import * as SignInAttemptsStore from "./agent/signInAttempts.ts";
import { signedOutOfSite } from "./signOuts.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitHubSourceControlCredential } from "../extensions/connectors/GitHubSourceControlCredential.ts";

export const syntheticValue = () => NodeCrypto.randomUUID();
const unavailable = () =>
  new AccountsError({ reason: "unavailable", message: "Synthetic source unavailable." });
export const noKeychain: AccountKeychain = {
  read: () => Effect.fail(unavailable()),
  unattendedWaitsForPerson: false,
  write: () => Effect.fail(unavailable()),
};

/**
 * A keychain in memory on Linux that records every read, for a desktop-mode backend whose desktop
 * launched it with `desktopBackgroundRunning` and the inherited `environment`.
 */
export const recordingKeychain = Effect.fn("AccountsTestkit.recordingKeychain")(function* (host: {
  readonly desktopBackgroundRunning: boolean | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const items = new Map<string, Redacted.Redacted<string>>();
  const reads: string[] = [];
  const keychain = yield* makeAccountKeychain({
    read: (account) =>
      Effect.sync(() => {
        reads.push(account);
        return items.get(account) ?? null;
      }),
    write: (account, value) =>
      Effect.sync(() => {
        items.set(account, value);
      }),
  }).pipe(
    Effect.provideService(ServerConfig, {
      mode: "desktop",
      desktopBackgroundRunning: host.desktopBackgroundRunning,
    } as ServerConfig["Service"]),
    Effect.provideService(HostProcess.Environment, host.environment ?? {}),
    Effect.provideService(HostProcess.Platform, "linux"),
  );
  return { keychain, reads };
});

/** A Scient window shown and in use until 2100: a person who can answer a keychain dialog. */
const windowLease: ClientActivityLease = {
  sessionId: AuthSessionId.make("synthetic-session"),
  rpcClientId: RpcClientId.make(1),
  clientId: "synthetic-window",
  clientKind: "desktop-renderer",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  scopes: [],
  updatedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
};

/** The host's power state, its lock as given. */
const hostPowerLocked = (locked: boolean): HostPowerSnapshot => ({
  source: "electron-main",
  idle: "false",
  idleSeconds: null,
  locked: locked ? "true" : "false",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: false,
  updatedAt: DateTime.makeUnsafe(0),
});

/**
 * The clients' shared leases and host power: `atWindow` puts someone at a Scient window or not,
 * `client` reports that window's lease changed by `patch`, and `hostLocked` locks the computer.
 */
export const windowLeases = Effect.fn("AccountsTestkit.windowLeases")(function* (open = false) {
  const leases: ClientActivityLeases["Service"] = {
    leases: yield* Ref.make(new Map<string, ClientActivityLease>()),
    hostPower: yield* Ref.make<Effect.Effect<HostPowerSnapshot> | undefined>(undefined),
  };
  const client = (patch: Partial<ClientActivityLease>) =>
    Ref.set(leases.leases, new Map([[windowLease.clientId, { ...windowLease, ...patch }]]));
  const atWindow = (present: boolean) => (present ? client({}) : Ref.set(leases.leases, new Map()));
  const hostLocked = (locked: boolean) =>
    Ref.set(leases.hostPower, Effect.succeed(hostPowerLocked(locked)));
  yield* atWindow(open);
  return { leases, atWindow, client, hostLocked };
});

export const memoryStore = () => {
  const blobs = new Map<string, Uint8Array>();
  const operations: string[] = [];
  let failWrite: string | undefined;
  let failRemove: string | undefined;
  /** Writes to `failWrite` start failing only once a name with this prefix is written. */
  let failAfter: string | undefined;
  /** The next write to this name waits for `release`, once `entered` says it began. */
  let pause:
    | { name: string; entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    | undefined;
  const store = ServerSecretStore.of({
    listNames: Effect.sync(() => [...blobs.keys()]),
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(blobs.get(name)?.slice())),
    set: (name, value) =>
      Effect.suspend(() => {
        if (pause?.name === name) {
          const held = pause;
          pause = undefined;
          return Deferred.succeed(held.entered, undefined).pipe(
            Effect.andThen(Deferred.await(held.release)),
            Effect.andThen(store.set(name, value)),
          );
        }
        if (name === failWrite && failAfter === undefined)
          return Effect.fail(
            new SecretStorePersistError({
              resource: "synthetic record",
              cause: new Error("Synthetic disk failure"),
            }),
          );
        operations.push(`set:${name}`);
        blobs.set(name, value.slice());
        if (failAfter !== undefined && name.startsWith(failAfter)) failAfter = undefined;
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
      Effect.suspend(() => {
        if (name === failRemove)
          return Effect.fail(
            new SecretStorePersistError({
              resource: "synthetic record",
              cause: new Error("Synthetic removal failure"),
            }),
          );
        operations.push(`remove:${name}`);
        blobs.delete(name);
        return Effect.void;
      }),
  });
  return {
    store,
    blobs,
    operations,
    failRemovalOf: (name: string | undefined) => {
      failRemove = name;
    },
    failWritesTo: (name: string | undefined, after?: string) => {
      failWrite = name;
      failAfter = after;
    },
    /** Holds the next write to `name` until `release` (`entered` once it begins). */
    pauseNextWriteTo: (name: string) => {
      const held = {
        name,
        entered: Deferred.makeUnsafe<void>(),
        release: Deferred.makeUnsafe<void>(),
      };
      pause = held;
      return { entered: held.entered, release: held.release };
    },
  };
};

export const makeHarness = Effect.fn("AccountsTestkit.make")(function* (
  options: {
    readonly storage?: ReturnType<typeof memoryStore>;
    readonly keychain?: AccountKeychain;
    readonly sourceOverrides?: Partial<AccountSources["Service"]>;
    /** What Source Control discovers and the GitHub credential it holds. */
    readonly sourceControl?: {
      readonly discover: SourceControlProviderRegistry["Service"]["discover"];
      readonly github: GitHubSourceControlCredential["Service"];
    };
    /** The clients' activity leases the vault reads as it opens (`windowLeases`); none: nobody. */
    readonly leases?: ClientActivityLeases["Service"];
  } = {},
) {
  const storage = options.storage ?? memoryStore();
  const { leases } = options;
  const vault = yield* makeAccountVault(
    storage.store,
    "/synthetic/accounts-test",
    options.keychain ?? noKeychain,
  ).pipe(
    leases === undefined ? (effect) => effect : Effect.provideService(ClientActivityLeases, leases),
  );
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
      Layer.provide(SignInAttemptsStore.layer),
      Layer.provide(Layer.succeed(AccountSources, sources)),
      Layer.provide(Layer.succeed(AccountVault, vault)),
      Layer.provide(Layer.succeed(ServerSecretStore, storage.store)),
      Layer.provide(
        options.sourceControl === undefined
          ? Layer.empty
          : Layer.mergeAll(
              Layer.mock(SourceControlProviderRegistry)({
                resolveLink: () => undefined,
                discover: options.sourceControl.discover,
                discoverProvider: (kind) =>
                  options.sourceControl!.discover.pipe(
                    Effect.map((items) =>
                      Option.fromUndefinedOr(items.find((item) => item.kind === kind)),
                    ),
                  ),
              }),
              Layer.succeed(GitHubSourceControlCredential, options.sourceControl.github),
            ),
      ),
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
    profileChoices?: BrowserProfileChoices;
    agentAccess?: boolean;
    denied?: boolean;
    values?: Readonly<Record<string, string>>;
    filledTab?: { accountId: AccountId; url: string };
  } = {},
) {
  const claimed = new Set<string>();
  const handoffs = new Map<string, AccountHandoff>();
  const chosen = new Map<string, string>();
  const needs = new Map<string, Omit<AccountNeedsYou, "since">>();
  const signOuts: Array<{ profileId: BrowserProfileId; site: string }> = [];
  const attempts = new Map<string, AccountSignInAttempt>();
  const signInEnds = new Map<AccountId, AccountSignInEnd>();
  const cancelled = new Set<string>();
  const uses: Array<Omit<AccountActivityEntry, "at" | "decision">> = [];
  const calls: string[] = [];
  const checks: Array<
    { accountId: AccountId } & Parameters<AccountsService["Service"]["recordCheck"]>[1]
  > = [];
  const accounts = [...(options.accounts ?? [])];
  const saves: Array<AccountSaveInput> = [];
  const unsupported = Effect.fail(
    new AccountsError({
      reason: "unsupported",
      message: "Not available in the synthetic account store.",
    }),
  );
  const service = AccountsService.of({
    signInAttempts: Effect.succeed(SignInAttemptsStore.makeSignInAttempts()),
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
    attempts: Effect.sync(() => [...attempts.values()]),
    setAttempt: (attempt) =>
      Effect.sync(() => {
        attempts.set(attempt.attemptId, attempt);
      }),
    removeAttempt: (id) =>
      Effect.sync(() => {
        attempts.delete(id);
      }),
    setSignInEnd: (end) =>
      Effect.sync(() => {
        signInEnds.set(end.accountId, end);
      }),
    beginSignOut: () => unsupported,
    settleSignOut: () => unsupported,
    supersedeSignOuts: () => Effect.void,
    renameIfUnchanged: () => unsupported,
    setPaperQueue: () => Effect.void,
    openWithoutPrompt: Effect.succeed(true),
    unattendedWaitsForPerson: Effect.succeed(false),
    showHandoff: () => unsupported,
    useSavedInHandoff: () => Effect.void,
    savedRequested: () => Effect.undefined,
    cancelHandoff: (id) =>
      Effect.sync(() => {
        cancelled.add(id);
      }),
    insertHandoffCode: (id, codeId) => Effect.sync(() => void chosen.set(id, codeId)),
    // As the service does: a click claims its hand-off when it's made, so Scient's own claim loses.
    claimHandoffCode: (id) =>
      Effect.sync(() => {
        if (chosen.has(id) || claimed.has(id)) return false;
        claimed.add(id);
        return true;
      }),
    setNeedsYou: (need) => Effect.sync(() => void needs.set(need.needId, need)),
    rememberSignOut: (profileId, site) =>
      Effect.sync(() => void signOuts.push({ profileId, site })),
    signedOut: Effect.sync(() => [...signOuts]),
    signOutSequence: Effect.sync(() => signOuts.length),
    signOutsSince: (sequence) => Effect.sync(() => signOuts.slice(sequence)),
    unlessSignedOutSince: (account, sequence, publish) =>
      signedOutOfSite(account, signOuts) || signedOutOfSite(account, signOuts.slice(sequence))
        ? Effect.succeed(false)
        : publish.pipe(Effect.as(true)),
    renewedAt: Effect.succeed({}),
    renewed: () => Effect.void,
    taskPins: Effect.succeed([]),
    unreadableTaskPins: Effect.succeed([]),
    addCodeNotice: () => Effect.succeed("notice-test"),
    codeNoticeDelivered: () => Effect.void,
    codeNoticeCleared: () => Effect.void,
    settleCodeNotice: () => Effect.void,
    withTaskEdit: (_taskId, effect) => effect,
    taskPinOf: () => Effect.undefined,
    signInFactors: Effect.succeed({}),
    deferredRenewals: Effect.succeed([]),
    setRenewalDeferred: () => Effect.void,
    noteSignInFactor: () => Effect.void,
    updateTaskPin: () => Effect.void,
    clearNeedsYou: (needId) => Effect.sync(() => void needs.delete(needId)),
    chosenHandoffCode: (id) =>
      Effect.sync(() => {
        const codeId = chosen.get(id);
        chosen.delete(id);
        if (codeId !== undefined) claimed.add(id);
        return codeId;
      }),
    passwordStore: () => unsupported,
    externalIdentities: Effect.succeed({ identities: [], complete: true }),
    snapshot: Effect.sync(
      () =>
        ({
          accounts,
          profiles: options.profiles ?? [],
          agentAccess: options.agentAccess ?? true,
        }) as unknown as AccountsSnapshot,
    ),
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
    restore: () => unsupported,
    agentRestore: () => unsupported,
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
    setRenewAutomatically: () => unsupported,
    renewAutomatically: Effect.succeed(true),
    updateProfile: () => unsupported,
    removeProfile: () => unsupported,
    profileStoreDone: () => unsupported,
    claimProfileStore: () => Effect.succeed({ ok: true }),
    desktopWriteCheck: () => Effect.succeed({ ok: false }),
    attachProfileStore: () => Effect.void,
    purgeProfiles: Effect.void,
    admitProfileTab: (_profileId, _threadId, open) => open,
    browserSources: Effect.succeed([]),
    undoProfileOperation: () => unsupported,
    operateProfile: () => unsupported,
    reportProfiles: () => unsupported,
    chooseProfile: () => unsupported,
    mainFilled: () => unsupported,
    profileSignedOut: () => unsupported,
    mainWithdrawn: () => unsupported,
    profileResend: () => unsupported,
    profileSendLog: () => unsupported,
    profileShared: () => unsupported,
    profilesUnshared: () => unsupported,
    receivedProfiles: unsupported,
    remoteSenders: unsupported,
    setRemoteSender: () => unsupported,
    senderKey: () => unsupported,
    keepSenderKey: () => unsupported,
    updateReceived: () => unsupported,
    mainBackfilled: () => unsupported,
    mainFolded: () => unsupported,
    retireProfile: () => unsupported,
    googleSessionsSeen: () => unsupported,
    sessionsSeen: () => unsupported,
    keepTyped: () => unsupported,
    keepFound: () => unsupported,
    takeBackupCode: () => unsupported,
    holdPending: () => unsupported,
    pending: () => unsupported,
    setCodeSources: () => unsupported,
    agentEdit: () => unsupported,
    agentControls: () => unsupported,
    agentRemove: () => unsupported,
    agentSaveOffer: () => unsupported,
    recordChange: () => Effect.void,
    checkCodeSources: unsupported,
    undoPasswordUpdate: () => unsupported,
    codeSourcesOn: Effect.succeed(false),
    codeSourcesVersion: Effect.succeed(0),
    setKeyLink: () => Effect.void,
    respondApproval: () => unsupported,
    activity: () => Effect.succeed([]),
    keychainCandidates: () => unsupported,
    connectOnePassword: () => unsupported,
    disconnectOnePassword: unsupported,
    importPasswords: () => unsupported,
    fillValues: () => unsupported,
    reveal: () => unsupported,
    usePassword: () => unsupported,
    removePasswordVersion: () => unsupported,
    restorePasswordVersion: () => unsupported,
    neverAsk: () => unsupported,
    startCard: () => Effect.void,
    recordCard: () => Effect.void,
    peek: () => Effect.succeed({ decision: "allowed" as const }),
    passwordVersion: () => Effect.undefined,
    rowVersion: () => Effect.undefined,
    takeFallback: (() => {
      const taken = new Set<string>();
      return (key: string) =>
        Effect.sync(() => {
          if (taken.has(key)) return false;
          taken.add(key);
          return true;
        });
    })(),
    filledTab: () => Effect.succeed(options.filledTab),
    matchSignIn: () => unsupported,
    forSession: () =>
      Effect.succeed({
        agentAccess: options.agentAccess ?? true,
        accounts,
        profiles: options.profiles ?? [],
        ...(options.profileChoices ? { profileChoices: options.profileChoices } : {}),
      }),
    authorizeUse: () =>
      options.denied
        ? Effect.fail(new AccountsError({ reason: "denied", message: "Synthetic denial." }))
        : Effect.void,
    authorize: (_scope, target, action) =>
      Effect.sync(() => {
        calls.push(`authorize:${target.type}:${action}`);
        return options.denied
          ? { decision: "denied" as const, reason: "off" as const }
          : { decision: "allowed" as const };
      }),
    resolveBound: () => unsupported,
    listBindable: () => unsupported,
    resolveCustomModelAccountKey: () => unsupported,
    resolveTextGeneratorKey: () => unsupported,
    resolveSpeechKey: () => Effect.die("Speech account resolution is unavailable in this fake"),
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
  return {
    service,
    calls,
    uses,
    handoffs,
    chosen,
    needs,
    signOuts,
    attempts,
    signInEnds,
    cancelled,
    saves,
    checks,
  };
}
