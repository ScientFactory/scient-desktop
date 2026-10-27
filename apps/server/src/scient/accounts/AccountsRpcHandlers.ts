import { AccountsError, WS_METHODS, WsAccountsRpcGroup } from "@t3tools/contracts";
import { Effect, Option, Stream } from "effect";
import type { ScientRpcObservers } from "../ScientRpcObservers.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";

export const makeAccountsRpcHandlers = ({
  accounts,
  observeRpcEffect,
  observeRpcStream,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  readonly accounts: AccountsServiceShape;
}) => {
  const attributes = { "rpc.aggregate": "accounts" };
  return WsAccountsRpcGroup.of({
    [WS_METHODS.accountsPasswordStore]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPasswordStore, accounts.passwordStore(input), attributes),
    [WS_METHODS.accountsSnapshot]: () =>
      observeRpcEffect(WS_METHODS.accountsSnapshot, accounts.snapshot, attributes),
    [WS_METHODS.accountsSubscribeChanges]: () =>
      observeRpcStream(WS_METHODS.accountsSubscribeChanges, accounts.changes, attributes),
    [WS_METHODS.accountsSave]: (input) =>
      observeRpcEffect(WS_METHODS.accountsSave, accounts.save(input), attributes),
    [WS_METHODS.accountsRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsRemove,
        accounts.remove(input.accountId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsTest]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsTest,
        accounts.test(input.accountId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSetControls]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSetControls,
        accounts.setControls(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSetAgentAccess]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSetAgentAccess,
        accounts.setAgentAccess(input.enabled).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsProfileUpdate]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileUpdate,
        accounts.updateProfile(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsProfileRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileRemove,
        accounts.removeProfile(input.profileId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsApprovalRespond]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsApprovalRespond,
        accounts.respondApproval(input.approvalId, input.decision).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsActivity]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsActivity,
        accounts.activity({
          ...(input.target ? { target: input.target } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        }),
        attributes,
      ),
    [WS_METHODS.accountsKeychainCandidates]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsKeychainCandidates,
        accounts.keychainCandidates(input.query),
        attributes,
      ),
    [WS_METHODS.accountsOnePasswordConnect]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsOnePasswordConnect,
        accounts.connectOnePassword(input),
        attributes,
      ),
    [WS_METHODS.accountsOnePasswordDisconnect]: () =>
      observeRpcEffect(
        WS_METHODS.accountsOnePasswordDisconnect,
        accounts.disconnectOnePassword,
        attributes,
      ),
    [WS_METHODS.accountsImportPasswords]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsImportPasswords,
        accounts.importPasswords(input),
        attributes,
      ),
    [WS_METHODS.accountsMatchSignIn]: (input) =>
      observeRpcEffect(WS_METHODS.accountsMatchSignIn, accounts.matchSignIn(input), attributes),
    [WS_METHODS.accountsFillValues]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsFillValues,
        accounts.fillValues(input.accountId, input.origin),
        attributes,
      ),
  });
};

const missingService = Effect.fail(
  new AccountsError({
    reason: "unavailable",
    message: "Scient Accounts is unavailable on this server.",
  }),
);

/** Every call fails the same way on a server without Accounts. */
const unavailable = Effect.fn("AccountsService.unavailable")(function* () {
  return yield* missingService;
});

export const accountsForRpc = Effect.serviceOption(AccountsService).pipe(
  Effect.map(
    Option.getOrElse(() =>
      AccountsService.of({
        passwordStore: unavailable,
        snapshot: missingService,
        changes: Stream.empty,
        save: unavailable,
        remove: unavailable,
        test: unavailable,
        setControls: unavailable,
        setAgentAccess: unavailable,
        updateProfile: unavailable,
        removeProfile: unavailable,
        respondApproval: unavailable,
        activity: unavailable,
        keychainCandidates: unavailable,
        connectOnePassword: unavailable,
        disconnectOnePassword: missingService,
        importPasswords: unavailable,
        fillValues: unavailable,
        matchSignIn: unavailable,
        forSession: unavailable,
        authorize: unavailable,
        resolveBound: unavailable,
        listBindable: unavailable,
        resolveSecrets: unavailable,
        recordUse: Effect.fn("AccountsService.recordUse")(function* () {}),
      }),
    ),
  ),
);
