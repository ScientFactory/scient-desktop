import {
  AccountsError,
  WS_METHODS,
  WsAccountsRpcGroup,
  type AccountsCheckInput,
} from "@t3tools/contracts";
import { Clock, Effect, Option, Stream } from "effect";
import { websiteSessionStatus } from "./websiteSessions.ts";
import { checkAccounts } from "./checkAccounts.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { ScientRpcObservers } from "../ScientRpcObservers.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";

export const makeAccountsRpcHandlers = ({
  accounts,
  observeRpcEffect,
  observeRpcStream,
  check,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  readonly accounts: AccountsServiceShape;
  readonly check: (input: AccountsCheckInput) => Effect.Effect<number, AccountsError>;
}) => {
  const observedSessions = new Set<string>();
  const attributes = { "rpc.aggregate": "accounts" };
  return WsAccountsRpcGroup.of({
    [WS_METHODS.accountsPasswordStore]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPasswordStore, accounts.passwordStore(input), attributes),
    [WS_METHODS.accountsSnapshot]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSnapshot,
        Effect.gen(function* () {
          const snapshot = yield* accounts.snapshot;
          const now = yield* Clock.currentTimeMillis;
          return {
            ...snapshot,
            accounts: websiteSessionStatus(
              snapshot.accounts,
              input.browserSessions ?? [],
              observedSessions,
              now,
              input.browserSessionSourceId,
              input.defaultProfileId,
            ),
          };
        }),
        attributes,
      ),
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
    [WS_METHODS.accountsCheck]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsCheck,
        check(input).pipe(Effect.map((checked) => ({ checked }))),
        attributes,
      ),
    [WS_METHODS.accountsSignInSeen]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSignInSeen,
        accounts
          .recordUse({
            target: { type: "account", accountId: input.accountId },
            action: "sign-in",
            signInOutcome: "signed-in",
            outcome: "ok",
          })
          .pipe(Effect.as({})),
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
    [WS_METHODS.accountsProfileChoose]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileChoose,
        accounts.chooseProfile(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsHandoffShow]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsHandoffShow,
        accounts.showHandoff(input.handoffId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsHandoffCancel]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsHandoffCancel,
        accounts.cancelHandoff(input.handoffId).pipe(Effect.as({})),
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
        accounts.fillValues(input.accountId, input.origin, input.tab),
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

/** The user's own account check; it needs the browser, which RPC handlers otherwise don't. */
export const accountsCheckForRpc = Effect.gen(function* () {
  const broker = yield* Effect.serviceOption(PreviewAutomationBroker);
  const accounts = yield* accountsForRpc;
  const environment = yield* ServerEnvironment;
  return (input: AccountsCheckInput) =>
    Option.isNone(broker)
      ? Effect.fail(
          new AccountsError({ reason: "unavailable", message: "The browser is unavailable." }),
        )
      : environment.getEnvironmentId.pipe(
          Effect.flatMap((environmentId) => checkAccounts(input, environmentId)),
          Effect.provideService(AccountsService, accounts),
          Effect.provideService(PreviewAutomationBroker, broker.value),
        );
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
        recordCheck: unavailable,
        setControls: unavailable,
        setAgentAccess: unavailable,
        updateProfile: unavailable,
        removeProfile: unavailable,
        chooseProfile: unavailable,
        setHandoff: unavailable,
        removeHandoff: Effect.fn("AccountsService.removeHandoff")(() => Effect.void),
        handoffCancelled: Effect.fn("AccountsService.handoffCancelled")(() =>
          Effect.succeed(false),
        ),
        cancelHandoff: unavailable,
        showHandoff: unavailable,
        respondApproval: unavailable,
        activity: unavailable,
        keychainCandidates: unavailable,
        connectOnePassword: unavailable,
        disconnectOnePassword: missingService,
        importPasswords: unavailable,
        fillValues: unavailable,
        filledTab: Effect.fn("AccountsService.filledTab")(() => Effect.sync(() => undefined)),
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
