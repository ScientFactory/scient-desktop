import type { SignInFactor } from "./signInCodes.ts";
/**
 * The Accounts owner. Values leave this service only as `Redacted` material for
 * Scient's own use (sign-in, brokered requests, per-session files) or through
 * `fillValues` to the user's authenticated client. See docs/internals/scient-accounts.md.
 */
import type { SignInAttempts } from "./agent/signInAttempts.ts";
import type { RemoteSender, SignOut, TaskPin } from "./AccountPersistence.ts";
import type { AccountEdit } from "./agentChanges.ts";

/**
 * Round 6e: where a store's write goes. The store holds the jar in that generation (refused once
 * the profile was cleared since). Round 6f: after its final read it hands its bounded writes to
 * `commit`, which runs the operation's check and the writes under one Accounts permit.
 */
export interface StoreWrite {
  readonly generation?: number;
  /** A copy's destination's generation; a copy's Undo writes there too. */
  readonly intoGeneration?: number;
  readonly commit?: <A>(write: Effect.Effect<A, AccountsError>) => Effect.Effect<A, AccountsError>;
  /** A copy's cookies each set in the destination, told while it is still held (round 6j). */
  readonly wrote?: (cookies: ReadonlyArray<SessionCookie>) => Effect.Effect<void, AccountsError>;
}

/**
 * This server's own browser, for a profile's Remove, Clear and sign-out (round 6b): registered by
 * the part of the server that holds it, so a person's and an agent's operations both reach it.
 */
export interface ProfileStore {
  /** A desktop runs alongside: its partitions take part in an operation. */
  readonly desktop: boolean;
  /**
   * Round 6e: the chats with a tab open in a profile, from this server's tabs. Accounts asks it
   * itself, so a check after a restart sees the tabs open now, not only what a caller passed.
   */
  readonly openTabs?: (profileId: BrowserProfileId) => Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Which generation each profile's data is in (absent: 0). */
  readonly generations: (generations: ReadonlyMap<string, number>) => Effect.Effect<void>;
  /** This computer, on a desktop: its own window carries out the desktop parts (round 6c). */
  readonly computer?: ReportingComputer;
  /**
   * Closes a profile's open browser, so its next tab opens in the current generation; fails when
   * the browser refuses, as for a fenced profile (round 6r).
   */
  readonly closeProfile: (profileId: BrowserProfileId) => Effect.Effect<void, AccountsError>;
  /** Round 6l: profiles this server's browser can't open until it starts again. */
  readonly unavailable?: () => ReadonlyArray<string>;
  /**
   * Signs the profile out of a site, returning what it removed; `keep` is handed those cookies
   * first, and nothing is removed unless it succeeds.
   */
  readonly signOut: (
    profileId: BrowserProfileId,
    site: string,
    keep?: (cookies: ReadonlyArray<SessionCookie>) => Effect.Effect<void, AccountsError>,
    write?: StoreWrite,
  ) => Effect.Effect<
    {
      readonly cookies: ReadonlyArray<SessionCookie>;
      /** Round 6f: the site's cookies no API can address, still there. */
      readonly leftBehind?: number;
    },
    AccountsError
  >;
  /** Undo: sets these back, but never over one set again since (`newer`: a newer sign-in). */
  readonly restore: (
    profileId: BrowserProfileId,
    cookies: ReadonlyArray<SessionCookie>,
    write?: StoreWrite,
  ) => Effect.Effect<
    { readonly restored: number; readonly refused: number; readonly newer?: number },
    AccountsError
  >;
  /**
   * Copies a profile's cookies for these sites (all when none) into another, over the same
   * cookies there; the destination's others stay. What it will replace is handed to `keep` before
   * anything changes. Sites the source has nothing for, or the destination refused, are named.
   */
  readonly copy: (
    from: BrowserProfileId,
    into: BrowserProfileId,
    sites: ReadonlyArray<string> | undefined,
    keep: (saved: {
      readonly before: ReadonlyArray<SessionCookie>;
      readonly copied: ReadonlyArray<SessionCookie>;
    }) => Effect.Effect<void, AccountsError>,
    write?: StoreWrite,
  ) => Effect.Effect<
    {
      readonly copied: number;
      readonly uncovered: ReadonlyArray<string>;
      readonly sites: ReadonlyArray<string>;
    },
    AccountsError
  >;
  /**
   * A copy's Undo: each copy still as it came goes, and the destination's own cookie it replaced
   * comes back; one set again since is a newer sign-in and stays (`newer`).
   */
  readonly restoreInto: (
    into: BrowserProfileId,
    copied: ReadonlyArray<SessionCookie>,
    before: ReadonlyArray<SessionCookie>,
    write?: StoreWrite,
  ) => Effect.Effect<
    { readonly restored: number; readonly refused: number; readonly newer?: number },
    AccountsError
  >;
  /** Deletes a profile's data in one generation, or in all of them; fails if it couldn't. */
  readonly purge: (
    profileId: BrowserProfileId,
    generation?: number,
  ) => Effect.Effect<void, AccountsError>;
}

/** Which chat an agent's change came from. */
export interface AccountChangeBy {
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
}

/** A value Scient found for a login: on a saved row, or on a new login made from what it showed. */
export interface FoundValue {
  /** A 2FA key, or backup codes (one per line). */
  readonly field: "totp" | "recovery";
  readonly value: Redacted.Redacted<string>;
  readonly accountId?: AccountId | undefined;
  /** The row as it was when it was chosen: changed since, the value isn't kept on it. */
  readonly updatedAt?: string | undefined;
  /** Kept only on a row that has no value in this field yet (an import never replaces one). */
  readonly onlyIfEmpty?: boolean | undefined;
  /** Kept only on a row still on this page's site and profile (as a pending secret's was). */
  readonly site?: { readonly origin: string; readonly profileId?: string | undefined } | undefined;
  readonly login?:
    | { readonly name: string; readonly details: Extract<AccountDetails, { kind: "website" }> }
    | undefined;
}
import type {
  AccountCodeNotice,
  ProfileClaimInput,
  ProfileClaimResult,
  BrowserSourceProfile,
  ReportingComputer,
  ProfileOperateInput,
  ProfileOperateResult,
  ProfileOperation,
  ProfileStoreDoneInput,
  SessionCookie,
  AccountChange,
  AccountKeyUse,
  TextGeneratorConfig,
  AccountPrivateUse,
  ApiKeyAuth,
  AccountSignIn,
  AccountCodeSources,
  AccountGoogleSessions,
  AccountSessionsSeenInput,
  AccountKeyLink,
  BrowserProfileChoiceInput,
  BrowserProfileChoices,
  AccountHandoff,
  AccountNeedsYou,
  AccountSignInAttempt,
  AccountSignInEnd,
  UniversitySignOut,
  UniversitySignOutTarget,
  PaperQueueSummary,
  CliPasswordStoreInput,
  CliPasswordStoreResult,
  AccountMatchSignInInput,
  AccountMatchSignInResult,
  AccountActivityEntry,
  AccountApprovalDecision,
  AccountFillValues,
  AccountFilledTab,
  CustomModelProtocol,
  AccountSaveInput,
  AccountSaveResult,
  AccountPendingInput,
  AccountPendingResult,
  AccountSetControlsInput,
  AccountsExternalIdentitiesResult,
  AccountsSnapshot,
  AccountStoresStatus,
  AccountDetails,
  AccountSummary,
  AccountTarget,
  BrowserProfileRecord,
  EnvironmentId,
  ProfileReceived,
  ProfileSendLog,
  ProfileSharedWith,
  SentProfileControls,
  AccountUseAction,
  BrowserProfileId,
  BrowserProfileRecordUpdateInput,
  KeychainCandidatesResult,
  OnePasswordConnectInput,
  PasswordImportInput,
  PasswordImportResult,
  ProjectId,
  ThreadId,
  VaultSecretRef,
  ConnectorId,
  DesktopWriteCheckInput,
  DesktopWriteCheckResult,
} from "@t3tools/contracts";
import { AccountId, AccountsError } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off -- Stable ids and digests for kept keys.
import * as NodeCrypto from "node:crypto";
import type { AccountAuthorization } from "@t3tools/shared/scientAccountAuthorization";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";

/**
 * Who uses a bound account key. A plugin key may have no site (local servers); then the
 * site check is skipped and the project scope is checked against `projectId` instead.
 */
export type AccountKeyConsumer =
  | {
      readonly kind: "connector";
      readonly connectorId: ConnectorId;
      readonly origin: string;
      /**
       * How the connector sends its key; only a key saved in that style fits a new choice. A
       * binding already made goes without: the connector sends it in its own style, as it did.
       */
      readonly auth?: ApiKeyAuth | undefined;
    }
  | {
      readonly kind: "plugin-key";
      readonly agent: string;
      readonly pluginId: string;
      readonly envName: string;
      readonly origin?: string;
      readonly projectId?: ProjectId;
    }
  /** A local connector's key; like a plugin key, it has no site and follows the project scope. */
  | {
      readonly kind: "local-connector";
      readonly connectorId: ConnectorId;
      readonly connector: string;
      readonly key: string;
      readonly projectId?: ProjectId;
    };

/** Server-derived identity of the agent session using an account; never request-supplied. */
export interface AccountSessionScope {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  /** Scheduled runs and other unattended work cannot wait for an approval card. */
  readonly unattended: boolean;
  /** The scheduled task this run serves: a pin on it binds every sign-in the run uses. */
  readonly scheduledTaskId?: string | undefined;
}

/** An agent's use of an account: its session, or agent work that has no conversation. */
export type AccountUseScope = Omit<AccountSessionScope, "threadId"> & {
  readonly threadId?: ThreadId | undefined;
};

/** What one session may see, Off included so agents can say so. Out-of-scope ones are absent. */
export interface SessionAccounts {
  readonly agentAccess: boolean;
  readonly accounts: ReadonlyArray<AccountSummary>;
  /** Every listed profile id with its effective record (defaults filled in). */
  readonly profiles: ReadonlyArray<BrowserProfileRecord>;
  readonly profileChoices?: BrowserProfileChoices | undefined;
}

export type { AccountAuthorization };

/** An Accounts error with its reason and a message written for the agent or the user. */
export const SPEECH_KEY_OUTSIDE_PROJECT = "The key is not available in this project.";

export type KeptKeyState = "new" | "kept" | "changed" | "removed";

/** The one row a use's typed key is kept in, so keeping it again replaces it in place. */
export const privateKeyId = (use: Pick<AccountPrivateUse, "kind" | "id">) =>
  AccountId.make(
    "acc_use_" +
      NodeCrypto.createHash("sha256")
        .update(use.kind + ":" + use.id)
        .digest("hex")
        .slice(0, 40),
  );

/** A digest of a typed value, as Accounts records it for a kept row. */
export const typedDigest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export const fail = (reason: AccountsError["reason"], message: string) =>
  new AccountsError({ reason, message });

export interface AccountsServiceShape {
  readonly setHandoff: (
    handoff: AccountHandoff,
    reveal?: Effect.Effect<void, AccountsError>,
  ) => Effect.Effect<void, AccountsError>;
  readonly removeHandoff: (handoffId: string) => Effect.Effect<void>;
  /** Sign-ins under way, by tab, in memory: their tabs are closed to agents meanwhile. */
  readonly attempts: Effect.Effect<ReadonlyArray<AccountSignInAttempt>>;
  readonly setAttempt: (attempt: AccountSignInAttempt) => Effect.Effect<void>;
  readonly removeAttempt: (attemptId: string) => Effect.Effect<void>;
  /** How the person's last sign-in to a row ended, in memory, shown wherever the row is. */
  readonly setSignInEnd: (end: AccountSignInEnd) => Effect.Effect<void>;
  /** Renames a row, only while it still has the name and library link it was read with. */
  readonly renameIfUnchanged: (
    accountId: AccountId,
    seen: { readonly name: string; readonly proxyUrl: string },
    name: string,
  ) => Effect.Effect<void, AccountsError>;
  /**
   * The person signs these rows out on purpose, in one write with the sign-out that clears
   * `targets`; a sign-out still clearing any of them is given back instead, to finish.
   */
  readonly beginSignOut: (
    accountIds: ReadonlyArray<AccountId>,
    targets: ReadonlyArray<UniversitySignOutTarget>,
  ) => Effect.Effect<UniversitySignOut, AccountsError>;
  /** Marks targets of a sign-out cleared; nothing when a newer sign-in ended it. */
  readonly settleSignOut: (
    opId: string,
    cleared: ReadonlyArray<UniversitySignOutTarget>,
  ) => Effect.Effect<UniversitySignOut | undefined, AccountsError>;
  /** The person's own sign-in on a row ends every sign-out of it still clearing. */
  readonly supersedeSignOuts: (accountId: AccountId) => Effect.Effect<void>;
  /** The state of a project's papers, shown as a band and a card. */
  readonly setPaperQueue: (queue: PaperQueueSummary) => Effect.Effect<void>;
  /**
   * For unattended work such as renewal: opens the store, with no dialog while the desktop may
   * run with no window. False when that needs the person: skip the work; the next foreground use
   * opens the store and `changes` emits.
   */
  readonly openWithoutPrompt: Effect.Effect<boolean, AccountsError>;
  /**
   * While the desktop may run with no window on macOS or Linux: unattended work that could open
   * the store asks `openWithoutPrompt` first. False: it opens the store as any use does.
   */
  readonly unattendedWaitsForPerson: Effect.Effect<boolean>;
  readonly handoffCancelled: (handoffId: string) => Effect.Effect<boolean>;
  readonly showHandoff: (handoffId: string) => Effect.Effect<void, AccountsError>;
  readonly cancelHandoff: (handoffId: string) => Effect.Effect<void, AccountsError>;
  /**
   * Asks the person once for something only they can do (`AccountNeedsYou`), kept across restarts
   * until `clearNeedsYou` or their dismissal. The same `needId` again replaces it, keeping `since`.
   */
  readonly setNeedsYou: (
    need: Omit<AccountNeedsYou, "since">,
  ) => Effect.Effect<void, AccountsError>;
  readonly clearNeedsYou: (needId: string) => Effect.Effect<void, AccountsError>;
  /** Records Accounts' Sign out of a site in a profile; a later sign-in there clears it. */
  readonly rememberSignOut: (
    profileId: BrowserProfileId,
    site: string,
  ) => Effect.Effect<void, AccountsError>;
  /** When renewal last finished a turn for each row, by account ID. */
  readonly renewedAt: Effect.Effect<Readonly<Record<string, string>>>;
  readonly renewed: (accountId: AccountId, at: string) => Effect.Effect<void, AccountsError>;
  /** Scheduled tasks pinned to a sign-in (`taskPins.ts`), kept until unpinned. */
  readonly taskPins: Effect.Effect<ReadonlyArray<TaskPin>>;
  /** Tasks whose stored pin can't be read: blocked until pinned again. */
  readonly unreadableTaskPins: Effect.Effect<ReadonlyArray<string>>;
  /**
   * One task's pin, read once the saved state is loaded: its pin, `unreadable`, or none. The
   * scheduler's gate asks this, so its first run after a start sees what was saved. Nothing saved
   * answers none without opening the store.
   */
  readonly taskPinOf: (
    scheduledTaskId: string,
  ) => Effect.Effect<TaskPin | "unreadable" | undefined, AccountsError>;
  /** Rows renewal looked at with nobody there and found signed out, by account ID. */
  readonly deferredRenewals: Effect.Effect<ReadonlyArray<string>>;
  readonly setRenewalDeferred: (accountId: AccountId, deferred: boolean) => Effect.Effect<void>;
  /** The second step each row's last sign-in met, as Scient saw it, by account ID. */
  readonly signInFactors: Effect.Effect<Readonly<Record<string, SignInFactor>>>;
  readonly noteSignInFactor: (accountId: AccountId, factor: SignInFactor) => Effect.Effect<void>;
  /**
   * Pins, updates or (answering `undefined`) unpins one scheduled task, from its pin as it is at
   * the write, so two writers never lose each other's change.
   */
  readonly updateTaskPin: (
    scheduledTaskId: string,
    update: (current: TaskPin | undefined) => TaskPin | undefined,
  ) => Effect.Effect<void, AccountsError>;
  /**
   * Runs `effect` as the only pin or trigger edit of this task: pinning reads the task's trigger
   * and the scheduler reads its pin, so neither may cross the other's write.
   */
  /**
   * Keeps a code notice for the person's phone, before the sign-in goes on; fails when it can't
   * be kept, and then the sign-in stops.
   */
  readonly addCodeNotice: (
    notice: Pick<AccountCodeNotice, "accountId" | "text">,
  ) => Effect.Effect<string, AccountsError>;
  /**
   * The relay took the notice for the phone. `current`, asked inside the write right before it
   * commits: false (the relay link changed since) writes nothing.
   */
  readonly codeNoticeDelivered: (
    noticeId: string,
    current?: () => boolean,
  ) => Effect.Effect<void, AccountsError>;
  /**
   * The relay took one of the notice's rows off the phone. The notice is kept, with its tombstones,
   * through their expiry (a day). `current` as for `codeNoticeDelivered`.
   */
  readonly codeNoticeCleared: (
    noticeId: string,
    row: "notice" | "settled",
    current?: () => boolean,
  ) => Effect.Effect<void, AccountsError>;
  /** Adds how the sign-in ended; the notice itself stays. */
  readonly settleCodeNotice: (
    noticeId: string,
    settled: NonNullable<AccountCodeNotice["settled"]>,
  ) => Effect.Effect<void>;
  readonly withTaskEdit: <A, E, R>(
    scheduledTaskId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The sign-outs `rememberSignOut` keeps, on this computer. */
  readonly signedOut: Effect.Effect<ReadonlyArray<SignOut>>;
  /**
   * Advances with every sign-out recorded here. A sign-in Scient makes by itself notes it first and
   * asks `signOutsSince` before each submit and when it settles: one made meanwhile ends it.
   */
  readonly signOutSequence: Effect.Effect<number>;
  readonly signOutsSince: (sequence: number) => Effect.Effect<ReadonlyArray<SignOut>>;
  /**
   * Runs `publish` under the accounts lock only if the row's site has no sign-out standing or made
   * after `sequence`, so no sign-out lands while it runs; `false` when it didn't run.
   */
  readonly unlessSignedOutSince: <E>(
    account: Pick<AccountSummary, "details">,
    sequence: number,
    publish: Effect.Effect<void, E>,
    /** A use `authorizeUse` must still allow, checked in the same locked step as the fence. */
    authorized?: {
      readonly scope: AccountUseScope;
      readonly target: AccountTarget;
      readonly use?: Parameters<AccountsServiceShape["authorizeUse"]>[2];
    },
  ) => Effect.Effect<boolean, E | AccountsError>;
  /** The person chose one of a hand-off's codes; its sign-in takes it on its next look. */
  readonly insertHandoffCode: (
    handoffId: string,
    codeId: string,
  ) => Effect.Effect<void, AccountsError>;
  /**
   * Scient's own code claims a hand-off before it goes in: false when the person's Insert came
   * first. The first claim, Scient's or the person's, is the only one.
   */
  readonly claimHandoffCode: (handoffId: string) => Effect.Effect<boolean>;
  /** The code the person chose for a hand-off, taken once. */
  readonly chosenHandoffCode: (handoffId: string) => Effect.Effect<string | undefined>;
  /** The person asks a waiting sign-in to type the saved password, through its own guarded path. */
  /** The person's Use saved, for the card revision they clicked; a stale one is refused. */
  readonly useSavedInHandoff: (
    handoffId: string,
    revision: string,
  ) => Effect.Effect<void, AccountsError>;
  /** The revision clicked, taken once by the waiting sign-in. */
  readonly savedRequested: (handoffId: string) => Effect.Effect<string | undefined>;
  // Client surface (RPC).
  readonly passwordStore: (
    input: CliPasswordStoreInput,
  ) => Effect.Effect<CliPasswordStoreResult, AccountsError>;
  readonly migrateCustomModelKeys?: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<AccountsSnapshot, AccountsError>;
  readonly externalIdentities: Effect.Effect<AccountsExternalIdentitiesResult, AccountsError>;
  readonly changes: Stream.Stream<AccountsSnapshot>;
  readonly save: (input: AccountSaveInput) => Effect.Effect<AccountSaveResult, AccountsError>;
  readonly remove: (
    accountId: AccountId,
    seenAt?: string | undefined,
    operationId?: string | undefined,
  ) => Effect.Effect<{ readonly removalId: string }, AccountsError>;
  /** Undo of that removal, for an hour: the row comes back with its id, values and controls. */
  readonly restore: (accountId: AccountId, removalId: string) => Effect.Effect<void, AccountsError>;
  /** An agent's Undo of its own removal, where it may still use the row; recorded with its chat. */
  readonly agentRestore: (
    accountId: AccountId,
    removalId: string,
    by: AccountChangeBy,
  ) => Effect.Effect<void, AccountsError>;
  readonly test: (accountId: AccountId) => Effect.Effect<void, AccountsError>;
  readonly setControls: (input: AccountSetControlsInput) => Effect.Effect<void, AccountsError>;
  /**
   * An agent's typed edit of an account (AMENDMENTS 56), at the version it read. An edit that
   * would widen where a value goes is refused. Recorded in `changes` with the agent's chat.
   */
  readonly agentEdit: (
    accountId: AccountId,
    seenAt: string,
    edit: AccountEdit,
    by: AccountChangeBy,
  ) => Effect.Effect<AccountSummary, AccountsError>;
  /**
   * An agent's controls change at the version it read: only ever tighter, as the controls stand
   * at commit, on a row or profile the agent may still manage there. Recorded.
   */
  readonly agentControls: (
    input: AccountSetControlsInput,
    version: string,
    by: AccountChangeBy,
  ) => Effect.Effect<void, AccountsError>;
  /** An agent's Remove at the version it read, rechecked under the write permit; with Undo. */
  readonly agentRemove: (
    accountId: AccountId,
    version: string,
    by: AccountChangeBy,
  ) => Effect.Effect<{ readonly removalId: string }, AccountsError>;
  /** Offer to save sign-ins for the account's sites again, at the version read. */
  readonly agentSaveOffer: (
    accountId: AccountId,
    version: string,
    by: AccountChangeBy,
  ) => Effect.Effect<void, AccountsError>;
  /** Records an agent's change for the person, with its chat. */
  readonly recordChange: (
    entry: Omit<AccountChange, "at" | "threadId" | "projectId">,
    by: AccountChangeBy,
  ) => Effect.Effect<void>;
  readonly setAgentAccess: (enabled: boolean) => Effect.Effect<void, AccountsError>;
  /** "Renew sign-ins automatically": off, renewal only looks. */
  readonly setRenewAutomatically: (enabled: boolean) => Effect.Effect<void, AccountsError>;
  readonly renewAutomatically: Effect.Effect<boolean>;
  readonly updateProfile: (
    input: BrowserProfileRecordUpdateInput,
  ) => Effect.Effect<void, AccountsError>;
  readonly removeProfile: (profileId: BrowserProfileId) => Effect.Effect<void, AccountsError>;
  readonly attachProfileStore: (store: ProfileStore) => Effect.Effect<void>;
  /**
   * A profile's Remove, Clear or site sign-out, by the person (`by` absent) or an agent, with
   * Undo for the hour. `openIn` are the chats with a tab open in it. A retry with the same
   * operation id returns the same receipt.
   */
  readonly operateProfile: (
    input: ProfileOperateInput,
    by: AccountChangeBy | undefined,
    /** The chats with a tab open in it: read under the write permit when given as an effect. */
    openIn: ReadonlyArray<ThreadId> | Effect.Effect<ReadonlyArray<ThreadId>>,
    /** An agent's: the profile's version it read. */
    version?: string,
  ) => Effect.Effect<ProfileOperateResult, AccountsError>;
  /**
   * Opens a tab in a profile: refused once it is removed or merged, and counted as open while it
   * opens, so a Remove or merge decided meanwhile sees it.
   */
  readonly admitProfileTab: <A, E, R>(
    profileId: BrowserProfileId,
    threadId: ThreadId,
    open: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AccountsError, R>;
  readonly undoProfileOperation: (
    operationId: string,
    by: AccountChangeBy | undefined,
  ) => Effect.Effect<ProfileOperation, AccountsError>;
  /**
   * Round 6f: the desktop's main process asks, at the moment its part writes, whether the
   * operation still stands. Never a claim: the desktop claimed its part before it began.
   */
  readonly desktopWriteCheck: (
    input: DesktopWriteCheckInput,
  ) => Effect.Effect<DesktopWriteCheckResult, AccountsError>;
  /** A desktop asks before carrying out its part of an operation or its Undo (round 6c). */
  readonly claimProfileStore: (
    input: ProfileClaimInput,
  ) => Effect.Effect<ProfileClaimResult, AccountsError>;
  /** The desktop's part of an operation or its Undo. */
  readonly profileStoreDone: (input: ProfileStoreDoneInput) => Effect.Effect<void, AccountsError>;
  /** Purges what the Undo hour no longer covers: removed profiles and generations left behind. */
  readonly purgeProfiles: Effect.Effect<void>;
  /**
   * A client's profiles: each gets a record with the name it is listed under, so agents and other
   * clients see the profile. A profile merged into Main or removed is left as it is.
   */
  readonly reportProfiles: (
    profiles: ReadonlyArray<{ readonly profileId: BrowserProfileId; readonly name: string }>,
    /** A desktop's browser profiles to import from, replacing what it reported before. */
    desktop?: {
      readonly computer: ReportingComputer;
      readonly sources: ReadonlyArray<BrowserSourceProfile>;
    },
  ) => Effect.Effect<void, AccountsError>;
  /** The browser profiles agents may import from, each with its id and whether its desktop is on. */
  readonly browserSources: Effect.Effect<
    ReadonlyArray<{
      readonly sourceId: string;
      readonly computer: ReportingComputer;
      readonly connected: boolean;
      readonly source: BrowserSourceProfile;
    }>
  >;
  /**
   * The fold's merge into Main: rows and choices naming the profile name Main, Main's own duplicate
   * winning, and its record is kept, marked retired. "undo" clears the mark for good.
   */
  readonly retireProfile: (
    profileId: BrowserProfileId,
    change: { readonly name: string } | "undo",
  ) => Effect.Effect<void, AccountsError>;
  /** Remembers the profile the user chose for a conversation (and its page's site) or project. */
  readonly chooseProfile: (input: BrowserProfileChoiceInput) => Effect.Effect<void, AccountsError>;
  readonly setCodeSources: (sources: AccountCodeSources) => Effect.Effect<void, AccountsError>;
  /**
   * Asks a new reader whether Messages or Mail opens, and shows the answer on every client's row.
   * Writes nothing, so it never turns reading back on. Fails on a server that isn't a Mac.
   */
  readonly checkCodeSources: Effect.Effect<boolean, AccountsError>;
  /**
   * Undoes a password update a working sign-in saved: each copy gets back its own earlier
   * password, and a copy changed since is left as it is.
   */
  readonly undoPasswordUpdate: (undoId: string) => Effect.Effect<
    {
      readonly restored: number;
      readonly changed: number;
      readonly mirrorsLeft?: ReadonlyArray<string>;
    },
    AccountsError
  >;
  /** Codes from this Mac are on now: the server is a Mac and the switch isn't off. Cheap. */
  readonly codeSourcesOn: Effect.Effect<boolean>;
  /** Advances with every change to the codes switch, in this process. */
  readonly codeSourcesVersion: Effect.Effect<number>;
  /**
   * A row's sign-in was copied into Main: Main's row for it gains its sites and username, or a
   * passwordless one is made, saying "Copied from …" until Main is seen signed in.
   */
  readonly mainFilled: (input: {
    readonly accountId: AccountId;
    readonly profileName: string;
  }) => Effect.Effect<void, AccountsError>;
  /**
   * Records Accounts' Sign out in a profile as a delete revision for other computers; Main also
   * keeps the site, so imports and back-fills never copy it back.
   */
  readonly profileSignedOut: (
    profileId: BrowserProfileId,
    site: string,
  ) => Effect.Effect<number, AccountsError>;
  /**
   * Main gave back a restricted profile's copy of a unit: a delete revision other computers apply
   * only to their copy of it, as Main sent it. Unlike Sign out, Main may copy the unit again.
   */
  readonly mainWithdrawn: (sites: ReadonlyArray<string>) => Effect.Effect<number, AccountsError>;
  /** A whole-jar revision: after an import or refresh into the profile, or Send again. */
  readonly profileResend: (
    profileId: BrowserProfileId,
    /** An agent's refresh: refused once it no longer stands (round 6k). */
    operationId?: string,
  ) => Effect.Effect<number, AccountsError>;
  readonly profileSendLog: (
    profileId: BrowserProfileId,
  ) => Effect.Effect<ProfileSendLog, AccountsError>;
  /** Unlinking a computer: no profile's deletions wait for it; `forgetKey` also drops its key. */
  readonly profilesUnshared: (
    environmentId: EnvironmentId,
    forgetKey: boolean,
  ) => Effect.Effect<void, AccountsError>;
  /** What another computer applied of the profile; entries all of them applied are dropped. */
  readonly profileShared: (
    profileId: BrowserProfileId,
    share: ProfileSharedWith,
  ) => Effect.Effect<void, AccountsError>;
  /** On a remote: the desktops that send sign-ins here. */
  readonly remoteSenders: Effect.Effect<ReadonlyArray<RemoteSender>, AccountsError>;
  /** The sign-in executor's locks and kept attempts, for the server's life. */
  readonly signInAttempts: Effect.Effect<SignInAttempts["Service"]>;
  /** On a remote: records a sender, or forgets it with `undefined`. */
  readonly setRemoteSender: (
    source: EnvironmentId,
    sender: RemoteSender | undefined,
  ) => Effect.Effect<void, AccountsError>;
  /** On the desktop: the key a computer issued it as a sender. */
  readonly senderKey: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<string | undefined, AccountsError>;
  readonly keepSenderKey: (
    environmentId: EnvironmentId,
    key: string,
  ) => Effect.Effect<void, AccountsError>;
  /** On a remote: the profiles holding copies from other computers, as stored. */
  readonly receivedProfiles: Effect.Effect<ReadonlyArray<BrowserProfileRecord>, AccountsError>;
  /**
   * On a remote: changes a profile's received copies, and the controls a sender sets, in one
   * locked commit. Returns the record as it was before the change.
   */
  readonly updateReceived: (
    profileId: BrowserProfileId,
    change: (record: BrowserProfileRecord) => {
      readonly received: ReadonlyArray<ProfileReceived>;
      readonly controls?: SentProfileControls;
    },
  ) => Effect.Effect<BrowserProfileRecord, AccountsError>;
  /** Records the profiles the one-time back-fill copied into Main; an empty list marks it done. */
  readonly mainBackfilled: (
    profileIds: ReadonlyArray<BrowserProfileId>,
  ) => Effect.Effect<void, AccountsError>;
  /** Records the one-time fold of Scient-made profiles into Main; kept as first recorded. */
  readonly mainFolded: (profiles: ReadonlyArray<string>) => Effect.Effect<void, AccountsError>;
  /**
   * Sessions in a profile, each on that profile's passwordless session row for its site: an import
   * makes one only where there is none, saying "Imported from …"; a sign-in seen there is an action
   * on it, or makes it. Saved passwords are separate rows and never take a session.
   */
  readonly sessionsSeen: (
    input: AccountSessionsSeenInput,
  ) => Effect.Effect<{ readonly created: ReadonlyArray<AccountId> }, AccountsError>;
  /**
   * Keeps a password the user typed in a sign-in that worked, in one locked step, unverified: only
   * a later sign-in where Scient types it verifies it. Never on a removed row or one that is Off,
   * and never over a linked password, which only gets an activity line.
   */
  readonly keepTyped: (
    accountId: AccountId,
    typed: { readonly username: string; readonly password: Redacted.Redacted<string> },
  ) => Effect.Effect<"kept" | "linked" | "dropped", AccountsError>;
  /**
   * Keeps values Scient found itself (a 2FA key from a setup page or an authenticator's export) on
   * their logins, or on a new login where none is named, with one Undo for all of them. Returns
   * the rows kept on.
   */
  readonly keepFound: (
    found: ReadonlyArray<FoundValue>,
  ) => Effect.Effect<ReadonlyArray<AccountId>, AccountsError>;
  /**
   * Takes the login's next unused backup code for the person's tap in a code step: it leaves the
   * saved list as it is typed, so it is never used twice. Undefined when none is left.
   */
  readonly takeBackupCode: (
    accountId: AccountId,
  ) => Effect.Effect<Redacted.Redacted<string> | undefined, AccountsError>;
  /**
   * Holds a 2FA key or backup codes a page showed as a private pending secret of its origin and
   * profile: the same value there again is the same record. Returns its id.
   */
  readonly holdPending: (input: {
    readonly kind: "totp" | "recovery";
    readonly value: Redacted.Redacted<string>;
    readonly origin: string;
    readonly profileId?: BrowserProfileId | undefined;
    readonly label?: string | undefined;
  }) => Effect.Effect<string, AccountsError>;
  /**
   * Starts a pending new password (`rotate`), gives the site's answer for it (`settle`: accepted
   * saves it on its login unless that login or its password changed meanwhile, which keeps both
   * for the person; unclear keeps it for the person), answers a pending secret (`save` to a
   * login, `discard`), or gives a held 2FA key's current code (`code`).
   */
  readonly pending: (
    input: AccountPendingInput,
  ) => Effect.Effect<AccountPendingResult, AccountsError>;
  /** Keeps one row per Google address in a profile, with the state Google reports. */
  readonly googleSessionsSeen: (input: AccountGoogleSessions) => Effect.Effect<void, AccountsError>;
  /**
   * Registers what takes followed keys back out of provider variables; Off, Remove and turning
   * agent access off run it for the links they reach, before they are committed.
   */
  readonly onAccessTaken?: (
    takeBack: (links: ReadonlyArray<AccountKeyLink>) => Effect.Effect<void, AccountsError>,
  ) => Effect.Effect<void>;
  /** Without an account, the variable keeps its value and stops following one. */
  readonly setKeyLink: (
    target: Pick<AccountKeyLink, "instanceId" | "variable">,
    accountId?: AccountId,
    copies?: AccountKeyLink["copies"],
    /** Only if the variable still follows this account: a later link is never overwritten. */
    expected?: AccountId,
  ) => Effect.Effect<void, AccountsError>;
  readonly respondApproval: (
    approvalId: string,
    decision: AccountApprovalDecision,
  ) => Effect.Effect<void, AccountsError>;
  readonly activity: (input: {
    readonly target?: AccountTarget;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<AccountActivityEntry>, AccountsError>;
  readonly keychainCandidates: (
    query: string | undefined,
  ) => Effect.Effect<KeychainCandidatesResult, AccountsError>;
  readonly connectOnePassword: (
    input: OnePasswordConnectInput,
  ) => Effect.Effect<AccountStoresStatus, AccountsError>;
  readonly disconnectOnePassword: Effect.Effect<AccountStoresStatus, AccountsError>;
  readonly importPasswords: (
    input: PasswordImportInput,
  ) => Effect.Effect<PasswordImportResult, AccountsError>;
  readonly fillValues: (
    accountId: AccountId,
    origin: string,
    tab?: AccountFilledTab,
    /** Recorded in Activity under this client's name: a fill not for this computer's desktop. */
    recordAs?: string,
    /** The client would submit it by itself: granted (`submit`) only within the site's budget. */
    autoSubmit?: boolean,
  ) => Effect.Effect<AccountFillValues, AccountsError>;
  /**
   * The one fallback a sign-in on `key` (from `attemptKeys`) may make, another password, route or
   * code, at most once a day per login, kept across restarts. University and staying call it too;
   * a caller that saw a lockout, rate-limit or CAPTCHA page doesn't.
   */
  readonly takeFallback: (key: string) => Effect.Effect<boolean>;
  /** An opaque version of the saved password, which changes whenever a new one is saved. */
  readonly passwordVersion: (accountId: AccountId) => Effect.Effect<string | undefined>;
  /** What `authorize` would decide now, this conversation's grants included, without asking. */
  readonly peek: (
    scope: AccountSessionScope,
    target: AccountTarget,
  ) => Effect.Effect<AccountAuthorization | { readonly decision: "ask" }>;
  /** An Accounts card opened: until it is recorded, an answer to it is still being kept. */
  readonly startCard: (requestId: string) => Effect.Effect<void>;
  /** How an Accounts card ended, and the row it saved into, for the card on every client. */
  readonly recordCard: (
    requestId: string,
    outcome: "saved" | "failed" | "declined" | "cancelled" | "timed_out",
    accountId?: AccountId,
  ) => Effect.Effect<void>;
  /** "Don't ask for this site", kept for every client, or taken back. */
  readonly neverAsk: (input: {
    readonly add?: ReadonlyArray<string> | undefined;
    readonly remove?: string | undefined;
  }) => Effect.Effect<void, AccountsError>;
  /**
   * The person's own Show or Copy of a website password, of the one it replaced, or of an earlier
   * one in its history (`version`); recorded.
   */
  readonly reveal: (
    accountId: AccountId,
    field: "password" | "previous" | "version",
    version?: string,
  ) => Effect.Effect<{ readonly value: string }, AccountsError>;
  /** The person puts an earlier password from the login's history (`version`) back as its own. */
  readonly usePassword: (
    accountId: AccountId,
    version: string,
  ) => Effect.Effect<void, AccountsError>;
  /**
   * The person removes an earlier password from the login's history (`version`): the only way
   * one leaves it, short of clearing or removing the login. Undo for the hour by `undoId`.
   */
  readonly removePasswordVersion: (
    accountId: AccountId,
    version: string,
  ) => Effect.Effect<{ readonly undoId: string }, AccountsError>;
  /** Brings a removed earlier password back, to the login as it was (`removePasswordVersion`). */
  readonly restorePasswordVersion: (undoId: string) => Effect.Effect<void, AccountsError>;
  /** The account autofill last put into this tab, while the tab still shows that page. */
  readonly filledTab: (
    threadId: ThreadId,
    tabId: string,
  ) => Effect.Effect<
    (Pick<AccountFilledTab, "url"> & { readonly accountId: AccountId }) | undefined
  >;

  readonly matchSignIn: (
    input: AccountMatchSignInInput,
  ) => Effect.Effect<AccountMatchSignInResult, AccountsError>;

  /**
   * Saved values a share must never carry: passwords, tokens, keys and one-time-code seeds stored
   * in Scient or as custom-model keys. Server-side only; external password managers are not asked.
   */
  readonly redactionValues?: Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>>;

  /** Lock-free authorization epoch. Undefined while the state needs initialization. */
  readonly bindingRevision?: Effect.Effect<number | undefined>;
  readonly recordBoundDenial?: (
    ref: VaultSecretRef,
    consumer: AccountKeyConsumer,
  ) => Effect.Effect<void>;

  /**
   * One use's outcome with a key: refused (a provider's 401/403) or worked. The key is marked
   * refused only when two uses refuse its current value; a success clears the mark.
   */
  readonly reportKeyUse?: (
    accountId: AccountId,
    use: AccountKeyUse,
    outcome: "refused" | "ok",
    /** `typedDigest` of the value the use sent: an answer about an older value is dropped. */
    sent: string,
  ) => Effect.Effect<void>;

  /**
   * Keeps a typed key as a row for that use only (`privateTo`): one row per use, replaced in
   * place when the use keeps a key again. Never listed, readable or bindable elsewhere.
   */
  readonly keepPrivateKey?: (input: {
    readonly use: AccountPrivateUse;
    readonly sites: ReadonlyArray<string>;
    readonly auth: ApiKeyAuth;
    readonly value: Redacted.Redacted<string>;
  }) => Effect.Effect<AccountId, AccountsError>;
  /**
   * Where a use's typed value stands: never kept, kept in its row, changed since it was kept
   * (or now sent to a site its row doesn't name), or kept and then removed, so this build never
   * sends it again.
   */
  readonly keptKeyState?: (
    use: Pick<AccountPrivateUse, "kind" | "id">,
    typed: Redacted.Redacted<string>,
    site?: string,
  ) => Effect.Effect<KeptKeyState, AccountsError>;

  // Extensions bindings: the saved binding is the user's approval for Ask access.
  readonly resolveBound: (
    ref: VaultSecretRef,
    consumer: AccountKeyConsumer,
    options?: { readonly auditAllowed?: boolean },
  ) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
  /** A row's version now, read before its value so `authorizeUse` refuses any edit since. */
  readonly rowVersion: (
    accountId: AccountId,
  ) => Effect.Effect<Pick<AccountSummary, "updatedAt"> | undefined, AccountsError>;
  /** Without an origin, every API-key account is offered. */
  readonly listBindable: (input: {
    readonly origin?: string;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly ref: VaultSecretRef; readonly name: string }>,
    AccountsError
  >;

  // Agent surface (Scient MCP tools).
  readonly forSession: (
    scope: AccountSessionScope,
    profileIds?: ReadonlyArray<BrowserProfileId>,
  ) => Effect.Effect<SessionAccounts, AccountsError>;
  /**
   * The one gate right before an agent's use acts: refuses Off, scope (with no project, any row
   * short of every project), the global switch, another site (`origin`), any edit but access or
   * scope since `since` (the row as its value was read), and another use's key. Never asks; with
   * no thread Ask is refused. `linked`: the person linked the row to this use, approving Ask.
   */
  readonly authorizeUse: (
    scope: AccountUseScope,
    target: AccountTarget,
    use?: {
      readonly origin?: string | undefined;
      readonly since?: Pick<AccountSummary, "updatedAt"> | undefined;
      readonly key?: { readonly kind: AccountKeyUse["kind"]; readonly id: string } | undefined;
      readonly linked?: boolean | undefined;
    },
  ) => Effect.Effect<void, AccountsError>;
  /**
   * Allowed passes at once; Ask waits for the user's card (denied at once when
   * unattended); Off, out-of-scope and the global switch deny. Records the decision.
   */
  readonly authorize: (
    scope: AccountSessionScope,
    target: AccountTarget,
    action: AccountUseAction,
    /** `waitMs`: the asking agent's time; its card closes by then. */
    options?: { readonly detail?: string; readonly waitMs?: number },
  ) => Effect.Effect<AccountAuthorization, AccountsError>;
  /** Resolves a saved API key for an owner-configured Custom models connection. */
  readonly resolveCustomModelAccountKey: (
    accountId: AccountId,
    origin: string,
    protocol?: CustomModelProtocol,
  ) => Effect.Effect<{ name: string; token: Redacted.Redacted<string> }, AccountsError>;
  /**
   * Checks a text generator's Accounts key against its endpoint and reads it, in one step. A
   * generator serves every project, so only a key for all projects fits.
   */
  readonly resolveTextGeneratorKey: (
    accountId: AccountId,
    generator: Pick<TextGeneratorConfig, "baseUrl" | "kind"> & { readonly id: string },
  ) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
  /** Resolves a sealed speech key for its exact HTTP origin. */
  /** Internal migration writer. The stable ID is assigned by the legacy slot owner. */
  readonly saveLegacySpeechKey?: (
    accountId: AccountId,
    origin: string,
    name: string,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AccountsError>;
  readonly resolveSpeechKey: (
    accountId: AccountId,
    origin: string,
    usage?: { provider: "compatible" | "openai" | "xai" | "openrouter"; jobId: string },
    projectId?: ProjectId,
    /** An agent's job, which agent Off stops too. */
    actor?: "agent",
  ) => Effect.Effect<{ name: string; token: Redacted.Redacted<string> }, AccountsError>;
  /** Resolves the named secret fields from wherever each lives. Call only after `authorize`. */
  readonly resolveSecrets: (
    accountId: AccountId,
    fields: ReadonlyArray<string>,
  ) => Effect.Effect<Readonly<Record<string, Redacted.Redacted<string>>>, AccountsError>;
  /**
   * Keeps what Scient last saw of a sign-in, through `withSignIn` as a look, dated by the server
   * clock. `username`, from the page, names a passwordless row that had none, when signed in.
   */
  readonly recordCheck: (
    accountId: AccountId,
    check: Omit<AccountSignIn, "at" | "by"> & { readonly username?: string | undefined },
  ) => Effect.Effect<void, AccountsError>;
  /**
   * Records the outcome of a use that `authorize` allowed; non-blocking unless `wait`, which a
   * sign-in needs so the next attempt on its site reads it. `savedPasswordUsed` (not kept in the
   * log) says Scient typed the saved password, so a `signed-in` outcome verifies it.
   */
  readonly recordUse: (
    entry: Omit<AccountActivityEntry, "at" | "decision"> & {
      readonly savedPasswordUsed?: boolean;
      /**
       * The person's own sign-in: the only outcome that replaces their university sign-out; signed
       * in, it also ends their sign-out of the site.
       */
      readonly byPerson?: boolean;
      /** The profile the sign-in ran in, when it isn't the row's. */
      readonly profileId?: BrowserProfileId;
      /** The row's `updatedAt` the sign-in started from: an outcome about a value since changed is dropped. */
      readonly version?: string;
      /**
       * The saved password the attempt typed (`passwordVersion`); a refusal is bound to it, and
       * a refusal or sign-in with it orders the login's password history.
       */
      readonly passwordVersion?: string;
      /** The same from the person's tab: a fill's one-time `attempt`, which counts once. */
      readonly attempt?: string;
    },
    message?: string,
    wait?: boolean,
  ) => Effect.Effect<void>;
}

export class AccountsService extends Context.Service<AccountsService, AccountsServiceShape>()(
  "t3/scient/accounts/AccountsService",
) {}
