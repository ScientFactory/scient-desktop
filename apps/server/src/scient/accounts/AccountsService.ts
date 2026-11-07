/**
 * The Accounts owner. Values leave this service only as `Redacted` material for
 * Scient's own use (sign-in, brokered requests, per-session files) or through
 * `fillValues` to the user's authenticated client. See docs/internals/scient-accounts.md.
 */
import type { SignInAttempts } from "./agent/signInAttempts.ts";
import type { RemoteSender } from "./AccountPersistence.ts";
import type {
  AccountSignIn,
  AccountCodeSources,
  AccountGoogleSessions,
  AccountSessionsSeenInput,
  AccountKeyLink,
  BrowserProfileChoiceInput,
  BrowserProfileChoices,
  AccountHandoff,
  AccountSignInAttempt,
  PaperQueueSummary,
  CliPasswordStoreInput,
  CliPasswordStoreResult,
  AccountMatchSignInInput,
  AccountMatchSignInResult,
  AccountActivityEntry,
  AccountApprovalDecision,
  AccountFillValues,
  AccountFilledTab,
  AccountId,
  AccountSaveInput,
  AccountSaveResult,
  AccountSetControlsInput,
  AccountsSnapshot,
  AccountStoresStatus,
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
} from "@t3tools/contracts";
import { AccountsError } from "@t3tools/contracts";
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
  | { readonly kind: "connector"; readonly connectorId: ConnectorId; readonly origin: string }
  | {
      readonly kind: "plugin-key";
      readonly agent: string;
      readonly pluginId: string;
      readonly envName: string;
      readonly origin?: string;
      readonly projectId?: ProjectId;
    };

/** Server-derived identity of the agent session using an account; never request-supplied. */
export interface AccountSessionScope {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  /** Scheduled runs and other unattended work cannot wait for an approval card. */
  readonly unattended: boolean;
}

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
  /** The state of a project's papers, shown as a band and a card. */
  readonly setPaperQueue: (queue: PaperQueueSummary) => Effect.Effect<void>;
  readonly handoffCancelled: (handoffId: string) => Effect.Effect<boolean>;
  readonly showHandoff: (handoffId: string) => Effect.Effect<void, AccountsError>;
  readonly cancelHandoff: (handoffId: string) => Effect.Effect<void, AccountsError>;
  // Client surface (RPC).
  readonly passwordStore: (
    input: CliPasswordStoreInput,
  ) => Effect.Effect<CliPasswordStoreResult, AccountsError>;
  readonly snapshot: Effect.Effect<AccountsSnapshot, AccountsError>;
  readonly changes: Stream.Stream<AccountsSnapshot>;
  readonly save: (input: AccountSaveInput) => Effect.Effect<AccountSaveResult, AccountsError>;
  readonly remove: (accountId: AccountId) => Effect.Effect<void, AccountsError>;
  readonly test: (accountId: AccountId) => Effect.Effect<void, AccountsError>;
  readonly setControls: (input: AccountSetControlsInput) => Effect.Effect<void, AccountsError>;
  readonly setAgentAccess: (enabled: boolean) => Effect.Effect<void, AccountsError>;
  readonly updateProfile: (
    input: BrowserProfileRecordUpdateInput,
  ) => Effect.Effect<void, AccountsError>;
  readonly removeProfile: (profileId: BrowserProfileId) => Effect.Effect<void, AccountsError>;
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
  readonly profileResend: (profileId: BrowserProfileId) => Effect.Effect<number, AccountsError>;
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
  /** Keeps one row per Google address in a profile, with the state Google reports. */
  readonly googleSessionsSeen: (input: AccountGoogleSessions) => Effect.Effect<void, AccountsError>;
  /** Without an account, the variable keeps its value and stops following one. */
  readonly setKeyLink: (
    target: Pick<AccountKeyLink, "instanceId" | "variable">,
    accountId?: AccountId,
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
  ) => Effect.Effect<AccountFillValues, AccountsError>;
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

  /** Lock-free authorization epoch. Undefined while the state needs initialization. */
  readonly bindingRevision?: Effect.Effect<number | undefined>;
  readonly recordBoundDenial?: (
    ref: VaultSecretRef,
    consumer: AccountKeyConsumer,
  ) => Effect.Effect<void>;

  // Extensions bindings: the saved binding is the user's approval for Ask access.
  readonly resolveBound: (
    ref: VaultSecretRef,
    consumer: AccountKeyConsumer,
    options?: { readonly auditAllowed?: boolean },
  ) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
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
   * Allowed passes at once; Ask waits for the user's card (denied at once when
   * unattended); Off, out-of-scope and the global switch deny. Records the decision.
   */
  readonly authorize: (
    scope: AccountSessionScope,
    target: AccountTarget,
    action: AccountUseAction,
    options?: { readonly detail?: string },
  ) => Effect.Effect<AccountAuthorization, AccountsError>;
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
    },
    message?: string,
    wait?: boolean,
  ) => Effect.Effect<void>;
}

export class AccountsService extends Context.Service<AccountsService, AccountsServiceShape>()(
  "t3/scient/accounts/AccountsService",
) {}
