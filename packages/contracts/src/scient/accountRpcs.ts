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
  AccountFillValues,
  AccountFillValuesInput,
  AccountRemoveInput,
  AccountSaveInput,
  AccountSaveResult,
  AccountSetControlsInput,
  AccountsError,
  AccountsSetAgentAccessInput,
  AccountsSnapshot,
  AccountsTestInput,
  AccountStoresStatus,
  BrowserProfileRecordRemoveInput,
  BrowserProfileRecordUpdateInput,
  KeychainCandidatesInput,
  KeychainCandidatesResult,
  OnePasswordConnectInput,
  PasswordImportInput,
  PasswordImportResult,
} from "./accounts.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_ACCOUNT_WS_METHODS = {
  accountsPasswordStore: "accounts.passwordStore",
  accountsSnapshot: "accounts.snapshot",
  accountsSubscribeChanges: "accounts.subscribeChanges",
  accountsSave: "accounts.save",
  accountsRemove: "accounts.remove",
  accountsTest: "accounts.test",
  accountsSetControls: "accounts.setControls",
  accountsSetAgentAccess: "accounts.setAgentAccess",
  accountsProfileUpdate: "accounts.profiles.update",
  accountsProfileRemove: "accounts.profiles.remove",
  accountsHandoffShow: "accounts.handoffs.show",
  accountsHandoffCancel: "accounts.handoffs.cancel",
  accountsApprovalRespond: "accounts.approvals.respond",
  accountsActivity: "accounts.activity",
  accountsKeychainCandidates: "accounts.keychain.candidates",
  accountsOnePasswordConnect: "accounts.onePassword.connect",
  accountsOnePasswordDisconnect: "accounts.onePassword.disconnect",
  accountsImportPasswords: "accounts.importPasswords",
  accountsFillValues: "accounts.fillValues",
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
  }),
  success: AccountsSnapshot,
  error: AccountsRpcError,
});

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
  success: Empty,
  error: AccountsRpcError,
});

/** Resolves every linked value without returning it; fails with the first problem. */
export const WsAccountsTestRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsTest, {
  payload: AccountsTestInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsSetControlsRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsSetControls, {
  payload: AccountSetControlsInput,
  success: Empty,
  error: AccountsRpcError,
});

export const WsAccountsSetAgentAccessRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsSetAgentAccess,
  { payload: AccountsSetAgentAccessInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsProfileUpdateRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileUpdate,
  { payload: BrowserProfileRecordUpdateInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsProfileRemoveRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsProfileRemove,
  { payload: BrowserProfileRecordRemoveInput, success: Empty, error: AccountsRpcError },
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

export const WsAccountsMatchSignInRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsMatchSignIn, {
  payload: AccountMatchSignInInput,
  success: AccountMatchSignInResult,
  error: AccountsRpcError,
});

export const WsAccountsHandoffCancelRpc = Rpc.make(
  SCIENT_ACCOUNT_WS_METHODS.accountsHandoffCancel,
  { payload: AccountHandoffCancelInput, success: Empty, error: AccountsRpcError },
);

export const WsAccountsHandoffShowRpc = Rpc.make(SCIENT_ACCOUNT_WS_METHODS.accountsHandoffShow, {
  payload: AccountHandoffCancelInput,
  success: Empty,
  error: AccountsRpcError,
});
