import {
  AccountsError,
  WS_METHODS,
  WsAccountsRpcGroup,
  type AccountKeyLink,
  type AccountPaperForSourceInput,
  type AccountPaperForSourceResult,
  type AccountPlainKey,
  type AccountPlainKeyInput,
  type AccountsCheckInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Clock, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { websiteSessionStatus } from "./websiteSessions.ts";
import { checkAccounts } from "./checkAccounts.ts";
import { getPaperForSource } from "../papers/getPaper.ts";
import { messagesReadable } from "./signIn/messageCodes.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { ScientRpcObservers } from "../ScientRpcObservers.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";

const isAccountsError = Schema.is(AccountsError);

export const makeAccountsRpcHandlers = ({
  accounts,
  observeRpcEffect,
  observeRpcStream,
  check,
  linkKey,
  paperForSource,
  plainKeys,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  readonly accounts: AccountsServiceShape;
  readonly check: (
    input: AccountsCheckInput,
  ) => Effect.Effect<{ checked: number; alreadyRunning?: boolean }, AccountsError>;
  readonly linkKey: (link: AccountKeyLink) => Effect.Effect<void, AccountsError>;
  readonly paperForSource: (
    input: AccountPaperForSourceInput,
  ) => Effect.Effect<typeof AccountPaperForSourceResult.Type, AccountsError>;
  readonly plainKeys: {
    readonly find: (
      roots: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<AccountPlainKey>, AccountsError>;
    readonly keep: (
      input: AccountPlainKeyInput,
      roots: ReadonlyArray<string>,
    ) => Effect.Effect<void, AccountsError>;
  };
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
      observeRpcEffect(WS_METHODS.accountsCheck, check(input), attributes),
    [WS_METHODS.accountsSignInSeen]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSignInSeen,
        accounts
          .recordUse({
            target: { type: "account", accountId: input.accountId },
            action: "sign-in",
            signInOutcome: input.outcome,
            outcome: input.outcome === "signed-in" ? "ok" : "error",
          })
          .pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsGoogleSessionsSeen]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsGoogleSessionsSeen,
        accounts.googleSessionsSeen(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSessionEnded]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionEnded,
        accounts.recordCheck(input.accountId, { state: "signed-out" }).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSetCodeSources]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSetCodeSources,
        accounts.setCodeSources(input).pipe(
          Effect.andThen(
            Effect.sync(() => ({
              messagesNeedAccess: input.messages && !messagesReadable(),
            })),
          ),
        ),
        attributes,
      ),
    [WS_METHODS.accountsPaperForSource]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPaperForSource, paperForSource(input), attributes),
    [WS_METHODS.accountsPlainKeys]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPlainKeys, plainKeys.find(input.roots), attributes),
    [WS_METHODS.accountsKeepPlainKey]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsKeepPlainKey,
        plainKeys.keep(input, input.roots).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsLinkKey]: (input) =>
      observeRpcEffect(WS_METHODS.accountsLinkKey, linkKey(input).pipe(Effect.as({})), attributes),
    [WS_METHODS.accountsUnlinkKey]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUnlinkKey,
        accounts.setKeyLink(input).pipe(Effect.as({})),
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

/** What the user runs themselves through the browser, which RPC handlers otherwise don't need. */
export const accountsUserRunsForRpc = Effect.gen(function* () {
  const broker = yield* Effect.serviceOption(PreviewAutomationBroker);
  const accounts = yield* accountsForRpc;
  const environment = yield* ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = <
    A,
    E,
    R extends AccountsService | PreviewAutomationBroker | FileSystem.FileSystem | Path.Path,
  >(
    effect: (environmentId: EnvironmentId) => Effect.Effect<A, E, R>,
  ) =>
    Option.isNone(broker)
      ? Effect.fail(
          new AccountsError({ reason: "unavailable", message: "The browser is unavailable." }),
        )
      : environment.getEnvironmentId.pipe(
          Effect.flatMap(effect),
          Effect.provideService(AccountsService, accounts),
          Effect.provideService(PreviewAutomationBroker, broker.value),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
  return {
    check: (input: AccountsCheckInput) =>
      run((environmentId) => checkAccounts(input, environmentId)),
    paperForSource: (input: AccountPaperForSourceInput) =>
      run((environmentId) =>
        getPaperForSource(input, environmentId).pipe(
          Effect.mapError((error) =>
            isAccountsError(error)
              ? error
              : new AccountsError({
                  reason: "unavailable",
                  message: "The PDF could not be fetched.",
                }),
          ),
        ),
      ),
  };
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
        googleSessionsSeen: unavailable,
        setCodeSources: unavailable,
        setKeyLink: unavailable,
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
