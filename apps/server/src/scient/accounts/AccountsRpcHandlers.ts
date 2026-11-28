import {
  AccountsError,
  WS_METHODS,
  WsAccountsRpcGroup,
  type AccountLinkKeyInput,
  type AccountSpeechConsumer,
  type AccountsSnapshot,
  type AccountRestoreKeptKeysInput,
  type AccountPaperForSourceInput,
  type AccountPaperForSourceResult,
  type PaperItem,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type PaperQueueInput,
  type PaperQueueContinueInput,
  type PaperQueueRequestInput,
  type Institution,
  type AccountSignInAsPersonInput,
  type UniversityBrowseInput,
  type UniversitySignOutInput,
  type UniversitySignOutResult,
  type AccountPlainKey,
  type AccountPlainKeyInput,
  type AccountsCheckInput,
  type EnvironmentId,
  type BrowserProfileId,
  ThreadId,
} from "@t3tools/contracts";
import { Clock, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { PreviewManager } from "../../preview/Manager.ts";
import { isGoogleSessionRow } from "./AccountDecisions.ts";
import { endedWebsiteSessions } from "./websiteSessions.ts";
import { checkAccounts, userRunInvocation } from "./checkAccounts.ts";
import {
  continuePapersAsUser,
  continueWaitingPapers,
  getPaperForSource,
  listPapersAsUser,
  requestPapersAsUser,
} from "../papers/getPaper.ts";
import { AccountAgentService } from "./agent/AccountAgentService.ts";
import { openThroughUniversity } from "./universityBrowsing.ts";
import { signOutUniversity } from "./universitySignOut.ts";
import { searchUniversities } from "../papers/universityDirectory.ts";
import { FetchHttpClient } from "effect/http";
import { codeSourcesReadable } from "./signIn/codeSourcesHelper.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { ScientRpcObservers } from "../ScientRpcObservers.ts";
import { makeSignInAttempts } from "./agent/signInAttempts.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";
import { checkKey } from "./keyCheck.ts";
import { keepFromPage } from "./twoFactorSetup.ts";
import { RemoteSessions, type AccountsCallerSession } from "./remoteSessions.ts";

const isAccountsError = Schema.is(AccountsError);

/** Another computer's copies need the socket's own session. */
const withCaller = <A>(
  caller: AccountsCallerSession | undefined,
  use: (
    remote: RemoteSessions["Service"],
    caller: AccountsCallerSession,
  ) => Effect.Effect<A, AccountsError>,
) =>
  caller === undefined
    ? Effect.fail(
        new AccountsError({ reason: "denied", message: "This connection can't send sign-ins." }),
      )
    : withRemoteSessions((remote) => use(remote, caller));

/** The server-lifetime receiver; older test harnesses and servers without a browser have none. */
/** The chats with a tab open in a profile, from this server's tabs. */
const openTabsIn = (profileId: string) =>
  Effect.serviceOption(PreviewManager).pipe(
    Effect.flatMap((manager) =>
      Option.isSome(manager) ? manager.value.profileTabs(profileId) : Effect.succeed([]),
    ),
    Effect.map((tabs) => [...new Set(tabs.map(({ threadId }) => ThreadId.make(threadId)))]),
  );

const withRemoteSessions = <A>(
  use: (remote: RemoteSessions["Service"]) => Effect.Effect<A, AccountsError>,
) =>
  Effect.serviceOption(RemoteSessions).pipe(
    Effect.flatMap((remote) =>
      Option.isSome(remote)
        ? use(remote.value)
        : Effect.fail(
            new AccountsError({
              reason: "unavailable",
              message: "This computer can't receive sign-ins.",
            }),
          ),
    ),
  );

/** What the server sees of a tab before a fill: on the page's origin, elsewhere, or unknown. */
/** Without Accounts there are no pins, so a task edit needs no lock. */
const untouchedEdit = <A, E, R>(_taskId: string, effect: Effect.Effect<A, E, R>) => effect;

export type TabShows = "origin" | "elsewhere" | "unknown";

/**
 * This computer's desktop (its desktop sign-in) fills as it always has. Any other paired client
 * fills as before too, recorded in Activity with the client and the page: telling a paired desktop
 * from another client needs pairing to record the kind of device. A tab on another page gets nothing.
 */
const fillDecision = (caller: AccountsCallerSession | undefined, shows: TabShows) =>
  shows === "elsewhere"
    ? Effect.fail(
        new AccountsError({ reason: "denied", message: "The tab no longer shows this page." }),
      )
    : Effect.succeed({
        recordAs:
          caller?.subject === "desktop-bootstrap"
            ? undefined
            : (caller?.client ?? "another client"),
      });

/** The person's own sign-ins and typing; absent where Accounts runs without a browser. */
const accountAgent = Effect.serviceOption(AccountAgentService);

export const makeAccountsRpcHandlers = ({
  accounts,
  caller,
  observeRpcEffect,
  observeRpcStream,
  check,
  linkKey,
  paperForSource,
  papers,
  pageSealKey,
  plainKeys,
  restoreKeptKeys,
  speechConsumers,
  tabShows,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  /** Reads a tab's page through the browser host; absent where the server has no browser. */
  readonly tabShows?: (
    tab: { readonly threadId: ThreadId; readonly tabId: PreviewTabId },
    origin: string,
  ) => Effect.Effect<TabShows>;
  readonly accounts: AccountsServiceShape;
  /** The page-sealing key this backend shares with the desktop that runs it; none otherwise. */
  readonly pageSealKey?: Buffer | undefined;
  readonly speechConsumers?: Effect.Effect<readonly AccountSpeechConsumer[]>;
  /** The socket's authenticated session; another computer's copies are bound to it. */
  readonly caller?: AccountsCallerSession;
  readonly check: (
    input: AccountsCheckInput,
  ) => Effect.Effect<
    { checked: number; skipped?: number; alreadyRunning?: boolean },
    AccountsError
  >;
  readonly linkKey: (input: AccountLinkKeyInput) => Effect.Effect<void, AccountsError>;
  readonly restoreKeptKeys: (
    input: AccountRestoreKeptKeysInput,
  ) => Effect.Effect<void, AccountsError>;
  readonly paperForSource: (
    input: AccountPaperForSourceInput,
  ) => Effect.Effect<typeof AccountPaperForSourceResult.Type, AccountsError>;
  readonly papers: {
    readonly request: (input: PaperQueueRequestInput) => Effect.Effect<object, AccountsError>;
    readonly continue: (input: PaperQueueContinueInput) => Effect.Effect<object, AccountsError>;
    readonly list: (
      input: PaperQueueInput,
    ) => Effect.Effect<ReadonlyArray<PaperItem>, AccountsError>;
    readonly signInAsPerson: (
      input: AccountSignInAsPersonInput,
    ) => Effect.Effect<
      { readonly tabId: PreviewTabId; readonly threadId: ThreadId },
      AccountsError
    >;
    readonly universityBrowse: (
      input: UniversityBrowseInput,
    ) => Effect.Effect<{ readonly routed: boolean }, AccountsError>;
    readonly universitySignOut: (
      input: UniversitySignOutInput,
    ) => Effect.Effect<UniversitySignOutResult, AccountsError>;
    readonly universities: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<Institution>, AccountsError>;
  };
  /** The client's `roots` are ignored: the server scans its own projects. */
  readonly plainKeys: {
    readonly find: () => Effect.Effect<ReadonlyArray<AccountPlainKey>, AccountsError>;
    readonly keep: (input: AccountPlainKeyInput) => Effect.Effect<void, AccountsError>;
  };
}) => {
  // A server without the desktop's page-seal key can't open a capture: it doesn't offer one.
  const withPageSeal = (snapshot: AccountsSnapshot): AccountsSnapshot =>
    pageSealKey !== undefined || !snapshot.pendingFeatures?.includes("page-seal")
      ? snapshot
      : {
          ...snapshot,
          pendingFeatures: snapshot.pendingFeatures.filter((feature) => feature !== "page-seal"),
        };
  const withSpeechConsumers = (raw: AccountsSnapshot) => {
    const snapshot = withPageSeal(raw);
    return speechConsumers
      ? Effect.map(speechConsumers, (consumers) => ({ ...snapshot, speechConsumers: consumers }))
      : Effect.succeed(snapshot);
  };
  const observedSessions = new Set<string>();
  const attributes = { "rpc.aggregate": "accounts" };
  return WsAccountsRpcGroup.of({
    [WS_METHODS.accountsPasswordStore]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPasswordStore, accounts.passwordStore(input), attributes),
    [WS_METHODS.accountsSnapshot]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSnapshot,
        Effect.gen(function* () {
          yield* accounts.migrateCustomModelKeys ?? Effect.void;
          const snapshot = yield* accounts.snapshot;
          const ended = endedWebsiteSessions(
            snapshot.accounts,
            input.browserSessions ?? [],
            observedSessions,
            yield* Clock.currentTimeMillis,
            input.browserSessionSourceId,
            input.defaultProfileId,
          );
          const withCompatibilityManagedElsewhere = (value: typeof snapshot) =>
            input.omitExternalIdentities === true
              ? Effect.succeed(value)
              : accounts.externalIdentities.pipe(
                  Effect.map(({ identities }) => ({
                    ...value,
                    managedElsewhere: [
                      ...identities,
                      ...(value.managedElsewhere ?? []).filter(
                        (row) =>
                          row.kind !== "github" ||
                          !identities.some((ext) => ext.kind === row.kind && ext.id === row.id),
                      ),
                    ],
                  })),
                  Effect.orElseSucceed(() => value),
                );
          if (ended.length === 0) {
            return yield* withSpeechConsumers(snapshot).pipe(
              Effect.flatMap(withCompatibilityManagedElsewhere),
            );
          }
          // Kept like any other look at the site, so every reader sees the session end.
          yield* Effect.forEach(
            ended,
            (accountId) =>
              accounts.recordCheck(accountId, { state: "signed-out" }).pipe(Effect.ignore),
            { discard: true },
          );
          return yield* accounts.snapshot.pipe(
            Effect.flatMap(withSpeechConsumers),
            Effect.flatMap(withCompatibilityManagedElsewhere),
          );
        }),
        attributes,
      ),
    [WS_METHODS.accountsExternalIdentities]: () =>
      observeRpcEffect(
        WS_METHODS.accountsExternalIdentities,
        accounts.externalIdentities,
        attributes,
      ),
    [WS_METHODS.accountsSubscribeChanges]: () =>
      observeRpcStream(
        WS_METHODS.accountsSubscribeChanges,
        accounts.changes.pipe(Stream.mapEffect(withSpeechConsumers)),
        attributes,
      ),
    [WS_METHODS.accountsSave]: (input) =>
      observeRpcEffect(WS_METHODS.accountsSave, accounts.save(input), attributes),
    [WS_METHODS.accountsRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsRemove,
        accounts.remove(input.accountId, input.updatedAt, input.operationId),
        attributes,
      ),
    [WS_METHODS.accountsRestore]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsRestore,
        accounts.restore(input.accountId, input.removalId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsTest]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsTest,
        checkKey(input.accountId).pipe(
          Effect.map((result) => ({ result })),
          Effect.provideService(AccountsService, accounts),
        ),
        attributes,
      ),
    [WS_METHODS.accountsCheck]: (input) =>
      observeRpcEffect(WS_METHODS.accountsCheck, check(input), attributes),
    [WS_METHODS.accountsSignInSeen]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSignInSeen,
        accounts
          .recordUse(
            {
              target: { type: "account", accountId: input.accountId },
              action: "sign-in",
              signInOutcome: input.outcome,
              outcome: input.outcome === "signed-in" ? "ok" : "error",
              // The person submitted the saved password on the site themselves.
              byPerson: true,
              ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
            },
            undefined,
            true,
          )
          .pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsGoogleSessionsSeen]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsGoogleSessionsSeen,
        accounts.googleSessionsSeen(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSessionsSeen]: (input) =>
      observeRpcEffect(WS_METHODS.accountsSessionsSeen, accounts.sessionsSeen(input), attributes),
    [WS_METHODS.accountsKeepTyped]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsKeepTyped,
        accountAgent.pipe(
          Effect.flatMap((agent) =>
            Option.isNone(agent) ? Effect.succeed({ kept: false }) : agent.value.keepTyped(input),
          ),
        ),
        attributes,
      ),
    [WS_METHODS.accountsSessionEnded]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionEnded,
        Effect.gen(function* () {
          const row = (yield* accounts.snapshot).accounts.find(
            (account) => account.accountId === input.accountId,
          );
          // Google answers for its own rows; a page that bounced says nothing about them.
          if (row === undefined || isGoogleSessionRow(row)) return {};
          yield* accounts.recordCheck(input.accountId, { state: "signed-out" });
          return {};
        }),
        attributes,
      ),
    [WS_METHODS.accountsUndoPassword]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUndoPassword,
        accounts.undoPasswordUpdate(input.undoId),
        attributes,
      ),
    [WS_METHODS.accountsCheckCodeSources]: () =>
      observeRpcEffect(
        WS_METHODS.accountsCheckCodeSources,
        accounts.checkCodeSources.pipe(
          Effect.map((readable) => ({ messagesNeedAccess: !readable })),
        ),
        attributes,
      ),
    [WS_METHODS.accountsSetCodeSources]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSetCodeSources,
        accounts.setCodeSources(input).pipe(
          Effect.andThen(input.messages ? codeSourcesReadable() : Effect.succeed(true)),
          Effect.map((readable) => ({ messagesNeedAccess: !readable })),
        ),
        attributes,
      ),
    [WS_METHODS.accountsPaperForSource]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPaperForSource, paperForSource(input), attributes),
    [WS_METHODS.accountsPapersRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsPapersRequest,
        papers.request(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsPapersContinue]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsPapersContinue,
        papers.continue(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsPapersList]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPapersList, papers.list(input), attributes),
    [WS_METHODS.accountsSignInAsPerson]: (input) =>
      observeRpcEffect(WS_METHODS.accountsSignInAsPerson, papers.signInAsPerson(input), attributes),
    [WS_METHODS.accountsPageKeep]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsPageKeep,
        keepFromPage(input, pageSealKey).pipe(Effect.provideService(AccountsService, accounts)),
        attributes,
      ),
    [WS_METHODS.accountsPending]: (input) =>
      observeRpcEffect(WS_METHODS.accountsPending, accounts.pending(input), attributes),
    [WS_METHODS.accountsUniversitySignIn]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUniversitySignIn,
        papers.signInAsPerson(input),
        attributes,
      ),
    [WS_METHODS.accountsUniversitySignOut]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUniversitySignOut,
        papers.universitySignOut(input),
        attributes,
      ),
    [WS_METHODS.accountsUniversityBrowse]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUniversityBrowse,
        papers.universityBrowse(input),
        attributes,
      ),
    [WS_METHODS.accountsUniversitySearch]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUniversitySearch,
        papers.universities(input.query),
        attributes,
      ),
    [WS_METHODS.accountsPlainKeys]: () =>
      observeRpcEffect(WS_METHODS.accountsPlainKeys, plainKeys.find(), attributes),
    [WS_METHODS.accountsKeepPlainKey]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsKeepPlainKey,
        plainKeys.keep(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsLinkKey]: (input) =>
      observeRpcEffect(WS_METHODS.accountsLinkKey, linkKey(input).pipe(Effect.as({})), attributes),
    [WS_METHODS.accountsRestoreKeptKeys]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsRestoreKeptKeys,
        restoreKeptKeys(input).pipe(Effect.as({})),
        attributes,
      ),
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
    [WS_METHODS.accountsSetRenewAutomatically]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSetRenewAutomatically,
        accounts.setRenewAutomatically(input.enabled).pipe(Effect.as({})),
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
    [WS_METHODS.accountsProfilesClaim]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfilesClaim,
        accounts.claimProfileStore(input),
        attributes,
      ),
    [WS_METHODS.accountsProfilesStoreDone]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfilesStoreDone,
        accounts.profileStoreDone(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsProfilesUndo]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfilesUndo,
        accounts.undoProfileOperation(input.operationId, undefined),
        attributes,
      ),
    [WS_METHODS.accountsProfilesOperate]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfilesOperate,
        accounts.operateProfile(input, undefined, openTabsIn(input.profileId)),
        attributes,
      ),
    [WS_METHODS.accountsProfilesReport]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfilesReport,
        accounts
          .reportProfiles(
            input.profiles,
            input.computer && input.sources
              ? { computer: input.computer, sources: input.sources }
              : undefined,
          )
          .pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsMainFilled]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsMainFilled,
        accounts.mainFilled(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsProfileSignedOut]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileSignedOut,
        accounts
          .profileSignedOut(input.profileId, input.site)
          .pipe(Effect.map((revision) => ({ revision }))),
        attributes,
      ),
    [WS_METHODS.accountsMainWithdrawn]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsMainWithdrawn,
        accounts.mainWithdrawn(input.sites).pipe(Effect.map((revision) => ({ revision }))),
        attributes,
      ),
    [WS_METHODS.accountsProfileResend]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileResend,
        accounts
          .profileResend(input.profileId, input.operationId)
          .pipe(Effect.map((revision) => ({ revision }))),
        attributes,
      ),
    [WS_METHODS.accountsProfileSendLog]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileSendLog,
        accounts.profileSendLog(input.profileId),
        attributes,
      ),
    [WS_METHODS.accountsProfileShared]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileShared,
        accounts.profileShared(input.profileId, input.share).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsProfilesUnshared]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfilesUnshared,
        accounts
          .profilesUnshared(input.environmentId, input.forgetKey === true)
          .pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSessionsBind]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsBind,
        withCaller(caller, (remote, session) => remote.bind(session, input)),
        attributes,
      ),
    [WS_METHODS.accountsSessionsForget]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsForget,
        withRemoteSessions((remote) => remote.forgetSender(input.source)),
        attributes,
      ),
    [WS_METHODS.accountsSenderKey]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSenderKey,
        accounts
          .senderKey(input.environmentId)
          .pipe(Effect.map((key) => (key === undefined ? {} : { key: Redacted.make(key) }))),
        attributes,
      ),
    [WS_METHODS.accountsKeepSenderKey]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsKeepSenderKey,
        accounts.keepSenderKey(input.environmentId, Redacted.value(input.key)).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSessionsReceive]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsReceive,
        withCaller(caller, (remote, session) => remote.receive(session, input)),
        attributes,
      ),
    [WS_METHODS.accountsSessionsApplied]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsApplied,
        withCaller(caller, (remote, session) => remote.applied(session, input)),
        attributes,
      ),
    [WS_METHODS.accountsSessionsWithdraw]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsWithdraw,
        withCaller(caller, (remote, session) => remote.withdraw(session, input)),
        attributes,
      ),
    [WS_METHODS.accountsSessionsList]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsList,
        withRemoteSessions((remote) => remote.list(input.profileId)),
        attributes,
      ),
    [WS_METHODS.accountsSessionsSignOutLocal]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsSignOutLocal,
        withRemoteSessions((remote) => remote.signOutLocal(input.profileId, input.site)),
        attributes,
      ),
    [WS_METHODS.accountsMainBackfilled]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsMainBackfilled,
        accounts.mainBackfilled(input.profileIds).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsProfileRetire]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsProfileRetire,
        accounts
          .retireProfile(input.profileId, "undo" in input ? "undo" : { name: input.name })
          .pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsMainFolded]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsMainFolded,
        accounts.mainFolded(input.profiles).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsSessionsQualify]: () =>
      observeRpcEffect(
        WS_METHODS.accountsSessionsQualify,
        withRemoteSessions((remote) => remote.qualify()),
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
    [WS_METHODS.accountsNeedsYouDismiss]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsNeedsYouDismiss,
        accounts.clearNeedsYou(input.needId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsHandoffInsertCode]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsHandoffInsertCode,
        accounts.insertHandoffCode(input.handoffId, input.codeId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsHandoffUseSaved]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsHandoffUseSaved,
        accounts.useSavedInHandoff(input.handoffId, input.revision).pipe(Effect.as({})),
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
    [WS_METHODS.accountsNeverAsk]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsNeverAsk,
        accounts.neverAsk(input).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsReveal]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsReveal,
        accounts.reveal(input.accountId, input.field, input.version),
        attributes,
      ),
    [WS_METHODS.accountsUsePassword]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsUsePassword,
        accounts.usePassword(input.accountId, input.version).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsRemovePasswordVersion]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsRemovePasswordVersion,
        accounts.removePasswordVersion(input.accountId, input.version),
        attributes,
      ),
    [WS_METHODS.accountsRestorePasswordVersion]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsRestorePasswordVersion,
        accounts.restorePasswordVersion(input.undoId).pipe(Effect.as({})),
        attributes,
      ),
    [WS_METHODS.accountsFillValues]: (input) =>
      observeRpcEffect(
        WS_METHODS.accountsFillValues,
        (input.tab && tabShows
          ? tabShows(input.tab, input.origin)
          : Effect.succeed<TabShows>("unknown")
        ).pipe(
          Effect.flatMap((shows) => fillDecision(caller, shows)),
          Effect.flatMap(({ recordAs }) =>
            accounts.fillValues(
              input.accountId,
              input.origin,
              input.tab,
              recordAs,
              input.autoSubmit === true,
            ),
          ),
        ),
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
  const agent = yield* Effect.serviceOption(AccountAgentService);
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
    tabShows: (
      tab: { readonly threadId: ThreadId; readonly tabId: PreviewTabId },
      origin: string,
    ) =>
      Option.isNone(broker)
        ? Effect.succeed<TabShows>("unknown")
        : environment.getEnvironmentId.pipe(
            Effect.flatMap((environmentId) =>
              broker.value.invoke<PreviewAutomationStatus>({
                scope: userRunInvocation(tab.threadId, environmentId),
                operation: "status",
                input: {},
                tabId: tab.tabId,
                timeoutMs: 2_000,
                updateCurrentTab: false,
              }),
            ),
            Effect.map((status): TabShows => {
              if (status.tabId !== tab.tabId || !status.url || !URL.canParse(status.url))
                return "unknown";
              return new URL(status.url).origin === new URL(origin).origin ? "origin" : "elsewhere";
            }),
            Effect.orElseSucceed((): TabShows => "unknown"),
          ),
    // A check can find sessions back, so papers waiting on the user go on. A glance leaves them:
    // a paper that goes on may sign in elsewhere, and a glance never signs in.
    check: (input: AccountsCheckInput) =>
      run((environmentId) =>
        checkAccounts(input, environmentId).pipe(
          Effect.tap(({ checked }) =>
            checked > 0 && !input.glance ? continueWaitingPapers(environmentId) : Effect.void,
          ),
        ),
      ),
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
    papers: {
      signInAsPerson: (input: AccountSignInAsPersonInput) =>
        Option.isNone(agent)
          ? Effect.fail(
              new AccountsError({ reason: "unavailable", message: "The browser is unavailable." }),
            )
          : run((environmentId) => agent.value.signInAsPerson(input, environmentId)),
      universitySignOut: (input: UniversitySignOutInput) =>
        run((environmentId) => signOutUniversity(input, environmentId)),
      universityBrowse: (input: UniversityBrowseInput) =>
        run((environmentId) =>
          accounts.snapshot.pipe(
            Effect.flatMap((snapshot) =>
              openThroughUniversity(input, environmentId, snapshot.accounts),
            ),
            Effect.orElseSucceed(() => ({ routed: false })),
          ),
        ),
      request: (input: PaperQueueRequestInput) =>
        run((environmentId) => requestPapersAsUser(input, environmentId)),
      continue: (input: PaperQueueContinueInput) =>
        run((environmentId) => continuePapersAsUser(input, environmentId)),
      list: ({ root }: PaperQueueInput) =>
        run((environmentId) => listPapersAsUser(root, environmentId)),
      universities: (query: string) =>
        searchUniversities(query).pipe(Effect.provide(FetchHttpClient.layer)),
    },
  };
});

export const accountsForRpc = Effect.serviceOption(AccountsService).pipe(
  Effect.map(
    Option.getOrElse(() =>
      AccountsService.of({
        signInAttempts: Effect.succeed(makeSignInAttempts()),
        passwordStore: unavailable,
        snapshot: missingService,
        openWithoutPrompt: missingService,
        unattendedWaitsForPerson: Effect.succeed(false),
        externalIdentities: missingService,
        changes: Stream.empty,
        save: unavailable,
        remove: unavailable,
        restore: unavailable,
        agentRestore: unavailable,
        test: unavailable,
        recordCheck: unavailable,
        googleSessionsSeen: unavailable,
        sessionsSeen: unavailable,
        keepTyped: unavailable,
        keepFound: unavailable,
        takeBackupCode: unavailable,
        holdPending: unavailable,
        pending: unavailable,
        setCodeSources: unavailable,
        agentEdit: unavailable,
        agentControls: unavailable,
        agentRemove: unavailable,
        agentSaveOffer: unavailable,
        recordChange: Effect.fn("AccountsService.recordChange")(() => Effect.void),
        checkCodeSources: unavailable(),
        undoPasswordUpdate: unavailable,
        codeSourcesOn: Effect.succeed(false),
        codeSourcesVersion: Effect.succeed(0),
        setKeyLink: unavailable,
        setControls: unavailable,
        setAgentAccess: unavailable,
        setRenewAutomatically: unavailable,
        renewAutomatically: Effect.succeed(false),
        updateProfile: unavailable,
        removeProfile: unavailable,
        profileStoreDone: unavailable,
        claimProfileStore: unavailable,
        desktopWriteCheck: Effect.fn("AccountsService.desktopWriteCheck")(() =>
          Effect.succeed({ ok: false, message: "Accounts isn't open." }),
        ),
        attachProfileStore: Effect.fn("AccountsService.attachProfileStore")(() => Effect.void),
        purgeProfiles: Effect.void,
        admitProfileTab: Effect.fn("AccountsService.admitProfileTab")(function* <A, E, R>(
          _profileId: BrowserProfileId,
          _threadId: ThreadId,
          open: Effect.Effect<A, E, R>,
        ) {
          return yield* open;
        }),
        browserSources: Effect.succeed([]),
        undoProfileOperation: unavailable,
        operateProfile: unavailable,
        reportProfiles: unavailable,
        chooseProfile: unavailable,
        mainFilled: unavailable,
        profileSignedOut: unavailable,
        mainWithdrawn: unavailable,
        profileResend: unavailable,
        profileSendLog: unavailable,
        profileShared: unavailable,
        profilesUnshared: unavailable,
        receivedProfiles: Effect.succeed([]),
        remoteSenders: Effect.succeed([]),
        setRemoteSender: unavailable,
        senderKey: unavailable,
        keepSenderKey: unavailable,
        updateReceived: unavailable,
        mainBackfilled: unavailable,
        mainFolded: unavailable,
        retireProfile: unavailable,
        setHandoff: unavailable,
        removeHandoff: Effect.fn("AccountsService.removeHandoff")(() => Effect.void),
        attempts: Effect.succeed([]),
        setAttempt: Effect.fn("AccountsService.setAttempt")(() => Effect.void),
        removeAttempt: Effect.fn("AccountsService.removeAttempt")(() => Effect.void),
        setSignInEnd: Effect.fn("AccountsService.setSignInEnd")(() => Effect.void),
        renameIfUnchanged: unavailable,
        beginSignOut: unavailable,
        settleSignOut: unavailable,
        supersedeSignOuts: Effect.fn("AccountsService.supersedeSignOuts")(() => Effect.void),
        setPaperQueue: Effect.fn("AccountsService.setPaperQueue")(() => Effect.void),
        handoffCancelled: Effect.fn("AccountsService.handoffCancelled")(() =>
          Effect.succeed(false),
        ),
        cancelHandoff: unavailable,
        insertHandoffCode: unavailable,
        claimHandoffCode: Effect.fn("AccountsService.claimHandoffCode")(() =>
          Effect.succeed(false),
        ),
        setNeedsYou: unavailable,
        rememberSignOut: unavailable,
        signedOut: Effect.succeed([]),
        signOutSequence: Effect.succeed(0),
        signOutsSince: Effect.fn("AccountsService.signOutsSince")(() => Effect.succeed([])),
        unlessSignedOutSince: Effect.fn("AccountsService.unlessSignedOutSince")(
          <E>(_account: unknown, _sequence: number, publish: Effect.Effect<void, E>) =>
            publish.pipe(Effect.as(true)),
        ),
        renewedAt: Effect.succeed({}),
        renewed: unavailable,
        taskPins: Effect.succeed([]),
        unreadableTaskPins: Effect.succeed([]),
        addCodeNotice: Effect.fn("AccountsService.addCodeNotice")(() =>
          Effect.succeed("unavailable"),
        ),
        codeNoticeDelivered: Effect.fn("AccountsService.codeNoticeDelivered")(() => Effect.void),
        codeNoticeCleared: Effect.fn("AccountsService.codeNoticeCleared")(() => Effect.void),
        settleCodeNotice: Effect.fn("AccountsService.settleCodeNotice")(() => Effect.void),
        withTaskEdit: untouchedEdit,
        taskPinOf: Effect.fn("AccountsService.taskPinOf")(() => Effect.undefined),
        signInFactors: Effect.succeed({}),
        deferredRenewals: Effect.succeed([]),
        setRenewalDeferred: Effect.fn("AccountsService.setRenewalDeferred")(() => Effect.void),
        noteSignInFactor: Effect.fn("AccountsService.noteSignInFactor")(() => Effect.void),
        updateTaskPin: unavailable,
        clearNeedsYou: unavailable,
        chosenHandoffCode: Effect.fn("AccountsService.chosenHandoffCode")(() => Effect.undefined),
        useSavedInHandoff: unavailable,
        savedRequested: Effect.fn("AccountsService.savedRequested")(() => Effect.undefined),
        showHandoff: unavailable,
        respondApproval: unavailable,
        activity: unavailable,
        keychainCandidates: unavailable,
        connectOnePassword: unavailable,
        disconnectOnePassword: missingService,
        importPasswords: unavailable,
        fillValues: unavailable,
        reveal: unavailable,
        usePassword: unavailable,
        removePasswordVersion: unavailable,
        restorePasswordVersion: unavailable,
        neverAsk: unavailable,
        startCard: Effect.fn("AccountsService.startCard")(() => Effect.void),
        recordCard: Effect.fn("AccountsService.recordCard")(() => Effect.void),
        passwordVersion: Effect.fn("AccountsService.passwordVersion")(() => Effect.undefined),
        rowVersion: Effect.fn("AccountsService.rowVersion")(() => Effect.undefined),
        takeFallback: Effect.fn("AccountsService.takeFallback")(() => Effect.succeed(false)),
        peek: Effect.fn("AccountsService.peek")(() =>
          Effect.succeed({ decision: "denied", reason: "off" } as const),
        ),
        filledTab: Effect.fn("AccountsService.filledTab")(() => Effect.undefined),
        matchSignIn: unavailable,
        forSession: unavailable,
        authorize: unavailable,
        authorizeUse: unavailable,
        resolveBound: unavailable,
        listBindable: unavailable,
        resolveCustomModelAccountKey: unavailable,
        resolveTextGeneratorKey: unavailable,
        resolveSpeechKey: unavailable,
        resolveSecrets: unavailable,
        recordUse: Effect.fn("AccountsService.recordUse")(function* () {}),
      }),
    ),
  ),
);
