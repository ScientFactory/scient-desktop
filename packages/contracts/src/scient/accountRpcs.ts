import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  AccountBrowserSessions,
  CliPasswordStoreInput,
  CliPasswordStoreResult,
  AccountMatchSignInInput,
  AccountMatchSignInResult,
  AccountActivityEntry,
  AccountActivityInput,
  AccountApprovalRespondInput,
  AccountHandoffCancelInput,
  AccountHandoffUseSavedInput,
  AccountHandoffInsertCodeInput,
  AccountNeedsYouDismissInput,
  AccountFillValues,
  AccountFillValuesInput,
  AccountRevealInput,
  AccountRemovePasswordVersionResult,
  AccountRestorePasswordVersionInput,
  AccountUsePasswordInput,
  AccountNeverAskInput,
  AccountPasswordUndoInput,
  AccountPasswordUndoResult,
  AccountRevealResult,
  AccountRemoveInput,
  AccountRemoveResult,
  AccountRestoreInput,
  AccountSaveInput,
  AccountSaveResult,
  AccountSetControlsInput,
  AccountCodeSources,
  AccountGoogleSessions,
  AccountId,
  AccountCodeSourcesResult,
  AccountLinkKeyInput,
  AccountPaperForSourceInput,
  AccountPlainKey,
  AccountPlainKeyInput,
  AccountPlainKeysInput,
  AccountPaperForSourceResult,
  PaperItem,
  PaperQueueInput,
  PaperQueueContinueInput,
  PaperQueueRequestInput,
  Institution,
  UniversitySearchInput,
  AccountSignInAsPersonInput,
  AccountPageKeepInput,
  AccountPageKeepResult,
  AccountPendingInput,
  AccountPendingResult,
  UniversityBrowseInput,
  UniversitySignOutInput,
  UniversitySignOutResult,
  AccountKeyUnlinkInput,
  AccountRestoreKeptKeysInput,
  AccountMainBackfilledInput,
  AccountMainFoldedInput,
  AccountsQualifyCase,
  AccountMainFilledInput,
  AccountProfileResendInput,
  AccountProfileRevision,
  AccountProfileSendLogInput,
  AccountProfileSharedInput,
  AccountProfileUnsharedInput,
  AccountKeepSenderKeyInput,
  AccountSenderKey,
  AccountSenderKeyInput,
  AccountSessionsBindInput,
  AccountSessionsForgetInput,
  AccountSessionsBindResult,
  AccountProfileSignedOutInput,
  AccountMainWithdrawnInput,
  AccountSessionsApplied,
  AccountSessionsAppliedInput,
  AccountSessionsList,
  AccountSessionsListInput,
  AccountSessionsReceiveInput,
  AccountSessionsReceiveResult,
  AccountSessionsSignOutLocalInput,
  AccountSessionsSignOutLocalResult,
  AccountSessionsWithdrawInput,
  AccountSessionsWithdrawResult,
  ProfileSendLog,
  AccountSignInSeenInput,
  AccountSessionsSeenInput,
  AccountKeepTypedInput,
  AccountSessionsSeenResult,
  AccountsCheckInput,
  AccountsError,
  AccountsSetAgentAccessInput,
  AccountsSetRenewAutomaticallyInput,
  AccountsExternalIdentitiesResult,
  AccountsSnapshot,
  AccountKeyCheck,
  AccountsTestInput,
  AccountStoresStatus,
  BrowserProfileChoiceInput,
  BrowserProfileRecordRemoveInput,
  ProfileStoreDoneInput,
  ProfileClaimInput,
  ProfileClaimResult,
  ProfileUndoInput,
  ProfileOperation,
  ProfileOperateResult,
  ProfileOperateInput,
  BrowserProfilesReportInput,
  BrowserProfileRetireInput,
  BrowserProfileRecordUpdateInput,
  KeychainCandidatesInput,
  KeychainCandidatesResult,
  OnePasswordConnectInput,
  PasswordImportInput,
  PasswordImportResult,
} from "./accounts.ts";
import { PreviewTabId } from "../preview.ts";
import { ThreadId } from "../baseSchemas.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_ACCOUNT_WS_METHODS = {
  accountsPasswordStore: "accounts.passwordStore",
  accountsSnapshot: "accounts.snapshot",
  accountsExternalIdentities: "accounts.externalIdentities",
  accountsSubscribeChanges: "accounts.subscribeChanges",
  accountsSave: "accounts.save",
  accountsRemove: "accounts.remove",
  accountsRestore: "accounts.restore",
  accountsTest: "accounts.test",
  accountsCheck: "accounts.check",
  accountsSignInSeen: "accounts.signInSeen",
  accountsGoogleSessionsSeen: "accounts.googleSessions.seen",
  accountsSessionsSeen: "accounts.sessionsSeen",
  accountsKeepTyped: "accounts.keepTyped",
  accountsSessionEnded: "accounts.sessionEnded",
  accountsSetCodeSources: "accounts.codeSources.set",
  accountsCheckCodeSources: "accounts.codeSources.check",
  accountsUndoPassword: "accounts.passwords.undo",
  accountsLinkKey: "accounts.keys.link",
  accountsPaperForSource: "accounts.papers.getForSource",
  accountsPapersRequest: "accounts.papers.request",
  accountsPapersContinue: "accounts.papers.continue",
  accountsPapersList: "accounts.papers.list",
  accountsUniversitySearch: "accounts.universities.search",
  accountsSignInAsPerson: "accounts.signInAsPerson",
  accountsPageKeep: "accounts.page.keep",
  accountsPending: "accounts.pending",
  /** The old name of `accountsSignInAsPerson`, answered for one more release. */
  accountsUniversitySignIn: "accounts.universities.signIn",
  accountsUniversityBrowse: "accounts.universities.browse",
  accountsUniversitySignOut: "accounts.universities.signOut",
  accountsPlainKeys: "accounts.plainKeys.find",
  accountsKeepPlainKey: "accounts.plainKeys.keep",
  accountsUnlinkKey: "accounts.keys.unlink",
  accountsRestoreKeptKeys: "accounts.keys.restoreKept",
  accountsSetControls: "accounts.setControls",
  accountsSetAgentAccess: "accounts.setAgentAccess",
  accountsSetRenewAutomatically: "accounts.setRenewAutomatically",
  accountsProfileUpdate: "accounts.profiles.update",
  accountsProfileRemove: "accounts.profiles.remove",
  accountsProfilesStoreDone: "accounts.profiles.storeDone",
  accountsProfilesClaim: "accounts.profiles.claim",
  accountsProfilesUndo: "accounts.profiles.undo",
  accountsProfilesOperate: "accounts.profiles.operate",
  accountsProfilesReport: "accounts.profiles.report",
  accountsProfileRetire: "accounts.profiles.retire",
  accountsProfileChoose: "accounts.profiles.choose",
  accountsMainFilled: "accounts.main.filled",
  accountsMainBackfilled: "accounts.main.backfilled",
  accountsMainFolded: "accounts.main.folded",
  accountsSessionsQualify: "accounts.sessions.qualify",
  accountsSessionsReceive: "accounts.sessions.receive",
  accountsSessionsApplied: "accounts.sessions.applied",
  accountsSessionsWithdraw: "accounts.sessions.withdraw",
  accountsSessionsList: "accounts.sessions.list",
  accountsSessionsSignOutLocal: "accounts.sessions.signOutLocal",
  accountsProfileSendLog: "accounts.profiles.sendLog",
  accountsProfileResend: "accounts.profiles.resend",
  accountsProfileSignedOut: "accounts.profiles.signedOut",
  accountsMainWithdrawn: "accounts.main.withdrawn",
  accountsProfileShared: "accounts.profiles.shared",
  accountsProfilesUnshared: "accounts.profiles.unshared",
  accountsSessionsBind: "accounts.sessions.bind",
  accountsSessionsForget: "accounts.sessions.forget",
  accountsSenderKey: "accounts.computers.senderKey",
  accountsKeepSenderKey: "accounts.computers.keepSenderKey",
  accountsHandoffShow: "accounts.handoffs.show",
  accountsHandoffCancel: "accounts.handoffs.cancel",
  accountsHandoffInsertCode: "accounts.handoffs.insertCode",
  accountsNeedsYouDismiss: "accounts.needsYou.dismiss",
  accountsHandoffUseSaved: "accounts.handoffs.useSaved",
  accountsApprovalRespond: "accounts.approvals.respond",
  accountsActivity: "accounts.activity",
  accountsKeychainCandidates: "accounts.keychain.candidates",
  accountsOnePasswordConnect: "accounts.onePassword.connect",
  accountsOnePasswordDisconnect: "accounts.onePassword.disconnect",
  accountsImportPasswords: "accounts.importPasswords",
  accountsFillValues: "accounts.fillValues",
  accountsReveal: "accounts.reveal",
  accountsUsePassword: "accounts.usePassword",
  accountsRemovePasswordVersion: "accounts.passwordVersions.remove",
  accountsRestorePasswordVersion: "accounts.passwordVersions.restore",
  accountsNeverAsk: "accounts.neverAsk",
  accountsMatchSignIn: "accounts.matchSignIn",
} as const;

const AccountsRpcError = Schema.Union([AccountsError, EnvironmentAuthorizationError]);
const Empty = Schema.Struct({});
export const WsAccountsPasswordStoreRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsPasswordStore,
  {
    payload: CliPasswordStoreInput,
    success: CliPasswordStoreResult,
    error: AccountsRpcError,
  },
);

export const WsAccountsSnapshotRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSnapshot, {
  payload: Schema.Struct({
    browserSessions: Schema.optional(AccountBrowserSessions),
    browserSessionSourceId: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
    /** The user's default browser profile, used by accounts that don't name one. */
    defaultProfileId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    /** Updated clients fetch external GitHub identities on demand via accounts.externalIdentities. */
    omitExternalIdentities: Schema.optional(Schema.Boolean),
  }),
  success: AccountsSnapshot,
  error: AccountsRpcError,
});

export const WsAccountsExternalIdentitiesRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsExternalIdentities,
  {
    payload: Empty,
    success: AccountsExternalIdentitiesResult,
    error: AccountsRpcError,
  },
);

export const WsAccountsSubscribeChangesRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSubscribeChanges,
  { payload: Empty, success: AccountsSnapshot, error: AccountsRpcError, stream: true },
);

export const WsAccountsSaveRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSave, {
  payload: AccountSaveInput,
  success: AccountSaveResult,
  error: AccountsRpcError,
});

export const WsAccountsRemoveRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsRemove, {
  payload: AccountRemoveInput,
  success: AccountRemoveResult,
  error: AccountsRpcError,
});

/** Undo of Remove, while the server still keeps the row (Accounts protocol 2). */
export const WsAccountsRestoreRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsRestore, {
  payload: AccountRestoreInput,
  success: Empty,
  error: AccountsRpcError,
});

/**
 * Resolves every linked value without returning it, failing with the first problem; a key's
 * service is then asked whether it accepts the key (absent from older servers).
 */
export const WsAccountsTestRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsTest, {
  payload: AccountsTestInput,
  success: Schema.Struct({ result: Schema.optional(AccountKeyCheck) }),
  error: AccountsRpcError,
});

/** Opens browser sign-ins one at a time; results arrive through account changes. */
export const WsAccountsCheckRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsCheck, {
  payload: AccountsCheckInput,
  success: Schema.Struct({
    checked: Schema.Int,
    /** A whole run: sign-ins it left for another press, or with nothing to check yet. */
    skipped: Schema.optional(Schema.Int),
    alreadyRunning: Schema.optional(Schema.Boolean),
    /** A glance that looked and couldn't tell; the last known state stays. */
    unclear: Schema.optional(Schema.Boolean),
  }),
  error: AccountsRpcError,
});

export const WsAccountsSignInSeenRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSignInSeen, {
  payload: AccountSignInSeenInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsGoogleSessionsSeenRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsGoogleSessionsSeen,
  { payload: AccountGoogleSessions, success: Empty, error: AccountsRpcError },
);

export const WsAccountsSessionEndedRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSessionEnded, {
  payload: Schema.Struct({ accountId: AccountId }),
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsSetCodeSourcesRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSetCodeSources,
  { payload: AccountCodeSources, success: AccountCodeSourcesResult, error: AccountsRpcError },
);

/** Asks macOS afresh whether Messages or Mail opens; writes nothing. */
export const WsAccountsCheckCodeSourcesRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsCheckCodeSources,
  { payload: Empty, success: AccountCodeSourcesResult, error: AccountsRpcError },
);

export const WsAccountsUndoPasswordRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsUndoPassword, {
  payload: AccountPasswordUndoInput,
  success: AccountPasswordUndoResult,
  error: AccountsRpcError,
});

export const WsAccountsPaperForSourceRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsPaperForSource,
  {
    payload: AccountPaperForSourceInput,
    success: AccountPaperForSourceResult,
    error: AccountsRpcError,
  },
);

export const WsAccountsPapersRequestRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsPapersRequest,
  { payload: PaperQueueRequestInput, success: Schema.Struct({}), error: AccountsRpcError },
);

export const WsAccountsPapersContinueRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsPapersContinue,
  { payload: PaperQueueContinueInput, success: Schema.Struct({}), error: AccountsRpcError },
);

export const WsAccountsPapersListRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsPapersList, {
  payload: PaperQueueInput,
  success: Schema.Array(PaperItem),
  error: AccountsRpcError,
});

const signInAsPerson = {
  payload: AccountSignInAsPersonInput,
  /** `threadId` is where the tab opened; older servers leave it out. */
  success: Schema.Struct({ tabId: PreviewTabId, threadId: Schema.optional(ThreadId) }),
  error: AccountsRpcError,
};

export const WsAccountsSignInAsPersonRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSignInAsPerson,
  signInAsPerson,
);

/** Holds what the person's tab shows (a 2FA setup, backup codes) as a pending secret. */
export const WsAccountsPageKeepRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsPageKeep, {
  payload: AccountPageKeepInput,
  success: AccountPageKeepResult,
  error: AccountsRpcError,
});

/** Starts, settles, saves or discards a secret Scient holds privately until it is settled. */
export const WsAccountsPendingRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsPending, {
  payload: AccountPendingInput,
  success: AccountPendingResult,
  error: AccountsRpcError,
});

/** The same sign-in under its old name, for clients of the last release. */
export const WsAccountsUniversitySignInRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsUniversitySignIn,
  signInAsPerson,
);

export const WsAccountsUniversityBrowseRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsUniversityBrowse,
  {
    payload: UniversityBrowseInput,
    success: Schema.Struct({ routed: Schema.Boolean }),
    error: AccountsRpcError,
  },
);

export const WsAccountsUniversitySignOutRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsUniversitySignOut,
  { payload: UniversitySignOutInput, success: UniversitySignOutResult, error: AccountsRpcError },
);

export const WsAccountsUniversitySearchRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsUniversitySearch,
  {
    payload: UniversitySearchInput,
    success: Schema.Array(Institution),
    error: AccountsRpcError,
  },
);

export const WsAccountsPlainKeysRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsPlainKeys, {
  payload: AccountPlainKeysInput,
  success: Schema.Array(AccountPlainKey),
  error: AccountsRpcError,
});

export const WsAccountsKeepPlainKeyRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsKeepPlainKey, {
  payload: AccountPlainKeyInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsLinkKeyRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsLinkKey, {
  payload: AccountLinkKeyInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsUnlinkKeyRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsUnlinkKey, {
  payload: AccountKeyUnlinkInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsRestoreKeptKeysRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsRestoreKeptKeys,
  {
    payload: AccountRestoreKeptKeysInput,
    success: Empty,
    error: AccountsRpcError,
  },
);

export const WsAccountsSetControlsRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSetControls, {
  payload: AccountSetControlsInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsSetAgentAccessRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSetAgentAccess,
  { payload: AccountsSetAgentAccessInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsSetRenewAutomaticallyRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSetRenewAutomatically,
  { payload: AccountsSetRenewAutomaticallyInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsProfileUpdateRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileUpdate,
  { payload: BrowserProfileRecordUpdateInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsProfileRemoveRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileRemove,
  { payload: BrowserProfileRecordRemoveInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsProfilesStoreDoneRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfilesStoreDone,
  {
    payload: ProfileStoreDoneInput,
    success: Empty,
    error: AccountsRpcError,
  },
);

export const WsAccountsProfilesClaimRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfilesClaim,
  { payload: ProfileClaimInput, success: ProfileClaimResult, error: AccountsRpcError },
);

export const WsAccountsProfilesUndoRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsProfilesUndo, {
  payload: ProfileUndoInput,
  success: ProfileOperation,
  error: AccountsRpcError,
});

export const WsAccountsProfilesOperateRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfilesOperate,
  {
    payload: ProfileOperateInput,
    success: ProfileOperateResult,
    error: AccountsRpcError,
  },
);

export const WsAccountsProfilesReportRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfilesReport,
  {
    payload: BrowserProfilesReportInput,
    success: Empty,
    error: AccountsRpcError,
  },
);

export const WsAccountsProfileRetireRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileRetire,
  { payload: BrowserProfileRetireInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsApprovalRespondRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsApprovalRespond,
  { payload: AccountApprovalRespondInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsActivityRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsActivity, {
  payload: AccountActivityInput,
  success: Schema.Array(AccountActivityEntry),
  error: AccountsRpcError,
});

export const WsAccountsKeychainCandidatesRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsKeychainCandidates,
  { payload: KeychainCandidatesInput, success: KeychainCandidatesResult, error: AccountsRpcError },
);

export const WsAccountsOnePasswordConnectRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsOnePasswordConnect,
  { payload: OnePasswordConnectInput, success: AccountStoresStatus, error: AccountsRpcError },
);

export const WsAccountsOnePasswordDisconnectRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsOnePasswordDisconnect,
  { payload: Empty, success: AccountStoresStatus, error: AccountsRpcError },
);

export const WsAccountsImportPasswordsRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsImportPasswords,
  { payload: PasswordImportInput, success: PasswordImportResult, error: AccountsRpcError },
);

export const WsAccountsFillValuesRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsFillValues, {
  payload: AccountFillValuesInput,
  success: AccountFillValues,
  error: AccountsRpcError,
});

export const WsAccountsRevealRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsReveal, {
  payload: AccountRevealInput,
  success: AccountRevealResult,
  error: AccountsRpcError,
});

export const WsAccountsUsePasswordRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsUsePassword, {
  payload: AccountUsePasswordInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsRemovePasswordVersionRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsRemovePasswordVersion,
  {
    payload: AccountUsePasswordInput,
    success: AccountRemovePasswordVersionResult,
    error: AccountsRpcError,
  },
);

export const WsAccountsRestorePasswordVersionRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsRestorePasswordVersion,
  {
    payload: AccountRestorePasswordVersionInput,
    success: Empty,
    error: AccountsRpcError,
  },
);

export const WsAccountsNeverAskRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsNeverAsk, {
  payload: AccountNeverAskInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsProfileChooseRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileChoose,
  { payload: BrowserProfileChoiceInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsMatchSignInRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsMatchSignIn, {
  payload: AccountMatchSignInInput,
  success: AccountMatchSignInResult,
  error: AccountsRpcError,
});

export const WsAccountsHandoffCancelRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsHandoffCancel,
  { payload: AccountHandoffCancelInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsNeedsYouDismissRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsNeedsYouDismiss,
  { payload: AccountNeedsYouDismissInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsHandoffInsertCodeRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsHandoffInsertCode,
  { payload: AccountHandoffInsertCodeInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsHandoffUseSavedRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsHandoffUseSaved,
  { payload: AccountHandoffUseSavedInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsHandoffShowRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsHandoffShow, {
  payload: AccountHandoffCancelInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsMainFilledRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsMainFilled, {
  payload: AccountMainFilledInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsMainBackfilledRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsMainBackfilled,
  { payload: AccountMainBackfilledInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsMainFoldedRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsMainFolded, {
  payload: AccountMainFoldedInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsSessionsSeenRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSessionsSeen, {
  payload: AccountSessionsSeenInput,
  success: AccountSessionsSeenResult,
  error: AccountsRpcError,
});

export const WsAccountsKeepTypedRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsKeepTyped, {
  payload: AccountKeepTypedInput,
  success: Schema.Struct({ kept: Schema.Boolean }),
  error: AccountsRpcError,
});

/** Dev builds only: the cookie adapter's qualification on this computer's browser. */
export const WsAccountsSessionsQualifyRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsQualify,
  { payload: Empty, success: Schema.Array(AccountsQualifyCase), error: AccountsRpcError },
);

const accountRpc = <
  const Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
>(
  tag: Tag,
  payload: Payload,
  success: Success,
) => Rpc.make(tag, { payload, success, error: AccountsRpcError });

/** On a remote: one batch of a desktop's sign-ins, from the session that sends as `source`. */
export const WsAccountsSessionsReceiveRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsReceive,
  AccountSessionsReceiveInput,
  AccountSessionsReceiveResult,
);
export const WsAccountsSessionsAppliedRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsApplied,
  AccountSessionsAppliedInput,
  AccountSessionsApplied,
);
export const WsAccountsSessionsWithdrawRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsWithdraw,
  AccountSessionsWithdrawInput,
  AccountSessionsWithdrawResult,
);
export const WsAccountsSessionsListRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsList,
  AccountSessionsListInput,
  AccountSessionsList,
);
export const WsAccountsSessionsSignOutLocalRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsSignOutLocal,
  AccountSessionsSignOutLocalInput,
  AccountSessionsSignOutLocalResult,
);
/** On the desktop: the send log of one profile, names and numbers only. */
export const WsAccountsProfileSendLogRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileSendLog,
  AccountProfileSendLogInput,
  ProfileSendLog,
);
export const WsAccountsProfileResendRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileResend,
  AccountProfileResendInput,
  AccountProfileRevision,
);
export const WsAccountsProfileSignedOutRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileSignedOut,
  AccountProfileSignedOutInput,
  AccountProfileRevision,
);
export const WsAccountsMainWithdrawnRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsMainWithdrawn,
  AccountMainWithdrawnInput,
  AccountProfileRevision,
);
export const WsAccountsProfileSharedRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileShared,
  AccountProfileSharedInput,
  Empty,
);
export const WsAccountsProfilesUnsharedRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfilesUnshared,
  AccountProfileUnsharedInput,
  Empty,
);
/** On a remote: proves, or first establishes, which desktop sends as `source`. */
export const WsAccountsSessionsBindRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsBind,
  AccountSessionsBindInput,
  AccountSessionsBindResult,
);
/** On the desktop: the key a computer issued it, kept encrypted with Accounts. */
export const WsAccountsSenderKeyRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSenderKey,
  AccountSenderKeyInput,
  AccountSenderKey,
);
export const WsAccountsKeepSenderKeyRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsKeepSenderKey,
  AccountKeepSenderKeyInput,
  Empty,
);
/** On a remote: its owner forgets a desktop, so a reinstalled one can bind again. */
export const WsAccountsSessionsForgetRpc = accountRpc(
  SCIENT_ACCOUNT_WS_METHODS.accountsSessionsForget,
  AccountSessionsForgetInput,
  AccountSessionsWithdrawResult,
);
