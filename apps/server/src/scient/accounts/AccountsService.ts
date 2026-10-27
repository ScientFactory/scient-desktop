/**
 * The Accounts owner. Values leave this service only as `Redacted` material for
 * Scient's own use (sign-in, brokered requests, per-session files) or through
 * `fillValues` to the user's authenticated client. See docs/internals/scient-accounts.md.
 */
import type {
  CliPasswordStoreInput,
  CliPasswordStoreResult,
  AccountMatchSignInInput,
  AccountMatchSignInResult,
  AccountActivityEntry,
  AccountApprovalDecision,
  AccountFillValues,
  AccountId,
  AccountSaveInput,
  AccountSaveResult,
  AccountSetControlsInput,
  AccountsError,
  AccountsSnapshot,
  AccountStoresStatus,
  AccountSummary,
  AccountTarget,
  AccountUseAction,
  BrowserProfileId,
  BrowserProfileRecord,
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
}

export type AccountAuthorization =
  | { readonly decision: "allowed" }
  | {
      readonly decision: "denied";
      readonly reason: "off" | "declined" | "out-of-scope" | "timed-out";
    };

export interface AccountsServiceShape {
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
  ) => Effect.Effect<AccountFillValues, AccountsError>;

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
  /** Non-blocking; records the outcome of a use that `authorize` allowed. */
  readonly recordUse: (entry: Omit<AccountActivityEntry, "at" | "decision">) => Effect.Effect<void>;
}

export class AccountsService extends Context.Service<AccountsService, AccountsServiceShape>()(
  "t3/scient/accounts/AccountsService",
) {}
