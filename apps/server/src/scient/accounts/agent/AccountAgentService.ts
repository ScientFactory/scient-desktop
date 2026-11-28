import {
  INCOGNITO_BROWSER_PROFILE_ID,
  AccountsError,
  type AccountId,
  type AccountKeyCheck,
  type AccountSummary,
  type AccountTarget,
  type BrowserProfileRecord,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type AccountKeepTypedInput,
  type AccountSignInAsPersonInput,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { signInHeld } from "@t3tools/shared/scientAccountSignIn";
import {
  AccountsService,
  fail,
  typedDigest,
  type AccountSessionScope,
} from "../AccountsService.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { PreviewManager } from "../../../preview/Manager.ts";
import { isUniversitySignInService } from "../signInTabs.ts";

const isAccountsError = Schema.is(AccountsError);
import { AccountCookies, netscapeCookieJar } from "./cookies.ts";
import { accountGrant, profileGrant } from "../accessChanges.ts";
import { AccountSessionFiles, credentialContents, shellQuote } from "./sessionFiles.ts";
import { accountRequest } from "./request.ts";
import { accountSessionScope } from "./scope.ts";
import { authorizePreviewProfile } from "./previewProfileAccess.ts";
import { ScientAccountsToolkit } from "./tools.ts";
import { accountUsage, authorize, withAccountUse } from "./accountUse.ts";
import { fillField } from "./fillField.ts";
import {
  guardedSignIn,
  keepTyped,
  settleKeptOnClose,
  switchedOffFor,
  type SignInAttempt,
} from "./guardedSignIn.ts";
import { recordSignInEnd } from "./signInEnds.ts";
import { codeSenderSites } from "../signIn/mailCodes.ts";
import { continueWaitingPapers } from "../../papers/getPaper.ts";
import { lookAtAccount, userRunInvocation } from "../checkAccounts.ts";
import { checkKey } from "../keyCheck.ts";
import { findProfiles } from "./findProfiles.ts";
import { addAccount } from "./accountAdd.ts";
import { manageAccount, manageBrowserProfiles } from "./accountManage.ts";
import { withCardAllowance } from "./cardAllowance.ts";
import { setUpConnector } from "./connectorSetup.ts";
import {
  addConnector,
  checkConnector,
  controlConnector,
  copyConnector,
  listConnectors,
  saveConnector,
} from "./connectorAuthoring.ts";
import { previewInvoker } from "./broker.ts";
import { getPaper, paperStatus, queuePapers } from "../../papers/getPaper.ts";

const decodeCookies = Schema.decodeUnknownEffect(AccountCookies);
const encodeCookies = Schema.encodeEffect(Schema.fromJsonString(AccountCookies));

const getAccount = Effect.fn("AccountsAgent.getAccount")(function* (
  scope: AccountSessionScope,
  accountId: AccountId,
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  const account = session.accounts.find((item) => item.accountId === accountId);
  if (!account || !session.agentAccess)
    return yield* fail("denied", "This account is unavailable to this session.");
  return account;
});

/** Where an agent with the user's mail can look for the code a sign-in waits for. */
const codeHint = (account: AccountSummary, result: SignInAttempt) =>
  result.codeSince === undefined || account.details.kind !== "website"
    ? {}
    : {
        code: {
          from: codeSenderSites(account.details.sites),
          sentAfter: DateTime.formatIso(DateTime.makeUnsafe(result.codeSince)),
        },
      };

const checkOne = Effect.fn("AccountsAgent.check")(function* ({
  accountId,
}: {
  readonly accountId: AccountId;
}) {
  const accounts = yield* AccountsService;
  const scope = yield* accountSessionScope();
  const session = yield* accounts.forSession(scope);
  const account = session.agentAccess
    ? session.accounts.find((item) => item.accountId === accountId)
    : undefined;
  if (!account) return yield* fail("not-found", "Use an account from scient_accounts_list.");
  // Only what this agent may use now, without asking: Off, Ask and its profile are not looked at.
  const access = yield* effectiveAccess(account, session, scope);
  if (access.effective !== "allowed")
    return {
      state:
        account.details.kind === "website" ? (account.signIn?.state ?? "unknown") : account.status,
      reason: `${access.why}: not checked.`,
    };
  // A key's service is asked whether it accepts the key; a value that only reads isn't "works".
  let keyCheck: AccountKeyCheck | undefined;
  const reason =
    account.details.kind === "website"
      ? yield* lookAtAccount(account).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error.message)),
        )
      : yield* checkKey(accountId, undefined, scope).pipe(
          Effect.map((result) => {
            keyCheck = result;
            return result === "refused"
              ? "Its service refused the key."
              : result === "readable"
                ? "The saved value reads; its service has no check Scient can run."
                : undefined;
          }),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
  const after =
    (yield* accounts.snapshot).accounts.find((item) => item.accountId === accountId) ?? account;
  const detail = reason ?? after.signIn?.detail ?? after.statusMessage;
  return {
    // A key's saved value can read fine while its service refuses it: a refusal is said.
    state:
      after.details.kind === "website"
        ? (after.signIn?.state ?? "unknown")
        : after.signIn?.state === "failed" || keyCheck === "refused"
          ? "refused"
          : after.status,
    ...(detail ? { reason: detail } : {}),
    ...(after.secrets.password?.verifiedAt
      ? { lastWorked: after.secrets.password.verifiedAt }
      : {}),
    ...(after.details.kind === "website" && after.details.profileId
      ? { profileId: after.details.profileId }
      : {}),
    ...(signInHeld(after, yield* Clock.currentTimeMillis) ? { held: true } : {}),
  };
});

export const accountAgentOperations = {
  // check_all looks at each account as the agent's own Check does: it never signs in.
  scient_account_manage: (input: Parameters<typeof manageAccount>[0]) =>
    manageAccount(input, (accountId) => checkOne({ accountId })),
  scient_browser_profiles: manageBrowserProfiles,
  scient_account_check: checkOne,
  scient_accounts_list: Effect.fn("AccountsAgent.list")(function* () {
    const accounts = yield* AccountsService;
    const scope = yield* accountSessionScope();
    const invocation = yield* AgentInvocationContext;
    const broker = yield* PreviewAutomationBroker;
    const browser = invocation.capabilities.has("preview")
      ? yield* broker
          .invoke<PreviewAutomationStatus>({
            scope: invocation,
            operation: "status",
            input: {},
            updateCurrentTab: false,
          })
          .pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    const session = yield* accounts.forSession(
      scope,
      browser?.profiles?.map((profile) => profile.id),
    );
    const effective = session.agentAccess
      ? new Map(
          yield* Effect.forEach(session.accounts, (account) =>
            Effect.map(
              effectiveAccess(account, session, scope),
              (access) => [account.accountId, access] as const,
            ),
          ),
        )
      : new Map();
    const now = yield* Clock.currentTimeMillis;
    const health = new Map(
      (
        (yield* accounts.snapshot.pipe(Effect.orElseSucceed(() => undefined)))?.passwordHealth ?? []
      ).map((entry) => [entry.accountId, entry.finding] as const),
    );
    return {
      accounts: session.agentAccess
        ? session.accounts.map((account) => ({
            accountId: account.accountId,
            name: account.name,
            kind: account.details.kind,
            sites: "sites" in account.details ? account.details.sites : [],
            // A site can hold several accounts, and only this tells them apart.
            ...(account.controls.access !== "off" &&
            "username" in account.details &&
            account.details.username
              ? { username: account.details.username }
              : {}),
            access: account.controls.access,
            readable: account.controls.visibility === "readable",
            status: account.status,
            usage: accountUsage(account),
            ...(account.signIn ? { signIn: account.signIn.state } : {}),
            ...(account.signIn?.detail ? { reason: account.signIn.detail } : {}),
            ...(account.secrets.password?.verifiedAt
              ? { lastWorked: account.secrets.password.verifiedAt }
              : {}),
            ...(account.details.kind === "website" && account.details.profileId
              ? { profileId: account.details.profileId }
              : {}),
            ...(signInHeld(account, now) ? { held: true } : {}),
            ...(account.secrets.totp ? { twoFactor: true } : {}),
            ...(account.secrets["recovery"]?.left
              ? { backupCodes: account.secrets["recovery"].left }
              : {}),
            ...(health.has(account.accountId)
              ? { passwordHealth: health.get(account.accountId)! }
              : {}),
            ...effective.get(account.accountId),
          }))
        : [],
      profiles: session.agentAccess
        ? session.profiles
            .filter((profile) => profile.profileId !== INCOGNITO_BROWSER_PROFILE_ID)
            .map((profile) => ({
              profileId: profile.profileId,
              name:
                browser?.profiles?.find((item) => item.id === profile.profileId)?.name ??
                profile.source?.profileName ??
                profile.profileId,
              ...(profile.source?.email ? { email: profile.source.email } : {}),
              usage:
                profile.access === "off"
                  ? []
                  : profile.scriptSignIn
                    ? ["preview_open", "scient_account_browser_session"]
                    : ["preview_open"],
              access: profile.access,
              scriptSignIn: profile.scriptSignIn,
            }))
        : [],
      // Read only: no agent tool turns it on or off; the person does, in Accounts.
      renewAutomatically: yield* accounts.renewAutomatically,
    };
  }),
  scient_account_credentials: Effect.fn("AccountsAgent.credentials")(function* ({
    accountId,
  }: {
    accountId: AccountId;
  }) {
    const scope = yield* accountSessionScope();
    return yield* withAccountUse(
      scope,
      { type: "account", accountId },
      "credentials",
      Effect.gen(function* () {
        const accounts = yield* AccountsService;
        const files = yield* AccountSessionFiles;
        const account = yield* getAccount(scope, accountId);
        if (account.controls.visibility !== "readable")
          return yield* fail(
            "denied",
            "This account is hidden. The user can make it readable in Settings → Accounts & secrets.",
          );
        // Backup codes are used only on the person's tap, never handed to an agent.
        const fields = Object.keys(account.secrets).filter((field) => field !== "recovery");
        const values = yield* accounts.resolveSecrets(accountId, fields);
        if (fields.some((field) => values[field] === undefined))
          return yield* fail("unavailable", "An account value is unavailable.");
        const issuance = yield* files.begin(scope.threadId);
        const content = yield* Effect.try({
          try: () => credentialContents(account, values, issuance.directory),
          catch: () =>
            fail("invalid-input", "The account cannot be represented safely in credential files."),
        });
        yield* accounts.authorizeUse(scope, { type: "account", accountId }, { since: account });
        const paths = yield* files.issue(
          issuance,
          [accountGrant(account)],
          Object.entries(content.files),
        );
        return { paths, usage: content.usage };
      }),
    );
  }, withCardAllowance),
  scient_account_fill: Effect.fn("AccountsAgent.fillTool")(function* ({
    accountId,
    ...input
  }: ToolInput<"scient_account_fill">) {
    const scope = yield* accountSessionScope();
    return yield* withAccountUse(
      scope,
      { type: "account", accountId },
      "sign-in",
      Effect.flatMap(getAccount(scope, accountId), (account) =>
        Effect.gen(function* () {
          // An agent's fill is Scient typing by itself: the switch applies, as to its sign-ins.
          const off = yield* switchedOffFor(account.name);
          if (off !== undefined) return yield* fail("denied", off);
          return yield* fillField(scope, account, input);
        }),
      ),
    );
  }, withCardAllowance),
  scient_account_sign_in: Effect.fn("AccountsAgent.signInTool")(function* ({
    accountId,
    tabId,
    code,
  }: ToolInput<"scient_account_sign_in">) {
    const scope = yield* accountSessionScope();
    const account = yield* getAccount(scope, accountId);
    const result = yield* guardedSignIn({
      page: { tabId },
      signIn: account,
      caller: { kind: "agent", scope },
      code,
    });
    // Papers waiting for this sign-in go on, as after the user's own.
    if (result.outcome === "signed-in")
      yield* continueWaitingPapers((yield* AgentInvocationContext).environmentId, accountId);
    const { codeSince: _codeSince, ...shown } = result;
    return { ...shown, ...codeHint(account, result) };
  }, withCardAllowance),
  scient_account_request: Effect.fn("AccountsAgent.request")(function* (
    input: ToolInput<"scient_account_request">,
  ) {
    const scope = yield* accountSessionScope();
    const accountId = input.accountId;
    return yield* withAccountUse(
      scope,
      { type: "account", accountId },
      "request",
      Effect.gen(function* () {
        const accounts = yield* AccountsService;
        const files = yield* AccountSessionFiles;
        const account = yield* getAccount(scope, accountId);
        if (account.details.kind !== "api-key")
          return yield* fail("invalid-input", "Choose an API key account for a request.");
        const details = account.details;
        const values = yield* accounts.resolveSecrets(accountId, ["token"]);
        if (!values.token) return yield* fail("unavailable", "The account key is unavailable.");
        // The store may have waited on a prompt: Off, a narrower scope or any edit since (sites,
        // permission, auth style, key) stops it; the request uses the row as it was authorized.
        yield* accounts.authorizeUse(scope, { type: "account", accountId }, { since: account });
        const services = yield* Effect.context<never>();
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            accountRequest(
              input,
              details.sites,
              account.controls.permission === "read-only",
              details.auth,
              Redacted.value(values.token!),
              signal,
              undefined,
              (url) =>
                Effect.runPromiseWith(services)(
                  accounts.authorizeUse(
                    scope,
                    { type: "account", accountId },
                    { since: account, origin: url.origin },
                  ),
                ),
            ),
          catch: (cause) =>
            isAccountsError(cause)
              ? cause
              : fail("denied", "The account request could not be completed."),
        });
        // One use's outcome; the key counts as refused once a second use refuses it too.
        // Only a 401 refuses the key, and only a success shows it works; the rest says neither.
        const refused = response.status === 401;
        const worked = response.status >= 200 && response.status < 300;
        if (accounts.reportKeyUse && (refused || worked))
          yield* accounts
            .reportKeyUse(
              accountId,
              { kind: "request", id: accountId },
              refused ? "refused" : "ok",
              typedDigest(Redacted.value(values.token!)),
            )
            .pipe(Effect.exit);
        const note = refused
          ? {
              note: "The service refused this key. Call scient_account_add with this accountId to ask the user for a new one.",
            }
          : {};
        if (response.text && response.bytes.byteLength <= 256 * 1024)
          return {
            status: response.status,
            body: new TextDecoder().decode(response.bytes),
            ...note,
          };
        const path = (yield* files.issue(
          yield* files.begin(scope.threadId),
          [accountGrant(account)],
          [[`${accountId}-response`, response.bytes]],
        ))[0]!;
        return { status: response.status, path, ...note };
      }),
    );
  }, withCardAllowance),
  scient_account_find_profile: Effect.fn("AccountsAgent.findProfile")(function* (
    input: ToolInput<"scient_account_find_profile">,
  ) {
    return yield* findProfiles(
      yield* accountSessionScope(),
      yield* AgentInvocationContext,
      input.url,
    );
  }),
  scient_account_browser_session: Effect.fn("AccountsAgent.browserSession")(function* (
    input: ToolInput<"scient_account_browser_session">,
  ) {
    const scope = yield* accountSessionScope();
    const invocation = yield* AgentInvocationContext;
    if (!invocation.capabilities.has("preview"))
      return yield* fail("denied", "Browser access is disabled for this session.");
    if (
      !URL.canParse(input.url) ||
      new URL(input.url).protocol !== "https:" ||
      new URL(input.url).username ||
      new URL(input.url).password
    )
      return yield* fail("invalid-input", "Choose an HTTPS site for the browser session.");
    const accounts = yield* AccountsService;
    const broker = yield* PreviewAutomationBroker;
    const files = yield* AccountSessionFiles;
    const account =
      input.accountId === undefined ? undefined : yield* getAccount(scope, input.accountId);
    if (
      account &&
      (account.details.kind !== "website" || !anySiteMatches(account.details.sites, input.url))
    )
      return yield* fail("denied", "The requested site does not match this website account.");
    const { accounts: rows } = yield* accounts.snapshot;
    // The session at a university's sign-in service opens its mail and records too.
    if (isUniversitySignInService(rows, input.url))
      return yield* fail("denied", "A university's sign-in stays in the browser.");
    // A sign-in under way on the site is the user's until it ends.
    const signingIn = new Set((yield* accounts.attempts).map((attempt) => attempt.accountId));
    if (
      rows.some(
        (row) =>
          signingIn.has(row.accountId) &&
          row.details.kind === "website" &&
          anySiteMatches(row.details.sites, input.url),
      )
    )
      return yield* fail("denied", "The user is signing in to this site. Wait for the sign-in.");
    const profileId =
      input.profileId ??
      (account && "profileId" in account.details ? account.details.profileId : undefined);
    const invoke = previewInvoker(broker, invocation, {
      updateCurrentTab: false,
      mapError: () => fail("unavailable", "The browser session could not be exported."),
    });
    const status = yield* invoke<PreviewAutomationStatus>("status", {});
    const open = {
      ...(profileId === undefined ? {} : { profileId }),
      reuseExistingTab: false,
      open: false,
    };
    if (account)
      yield* authorize(scope, { type: "account", accountId: account.accountId }, "browser-session");
    const profile = yield* authorizePreviewProfile(scope, status, open, "browser-session");
    // Both grants as they stand once allowed: the files go if either changes.
    const granted = account ? yield* getAccount(scope, account.accountId) : undefined;
    const grants = [profileGrant(profile.record), ...(granted ? [accountGrant(granted)] : [])];
    const target: AccountTarget = { type: "profile", profileId: profile.profileId };
    const operation = Effect.gen(function* () {
      const existing = status.tabs?.find(
        (tab) => tab.ownedByCaller && tab.profileId === profile.profileId,
      );
      const opened = existing
        ? { tabId: existing.tabId }
        : yield* accounts.admitProfileTab(
            profile.profileId,
            scope.threadId,
            invoke<PreviewAutomationStatus>("open", { ...open, profileId: profile.profileId }),
          );
      if (!opened.tabId)
        return yield* fail("unavailable", "No browser tab is available for this profile.");
      // While a sign-in runs or waits in the profile, any of its sites may be that sign-in's by
      // now, through any tab: none of the profile's sessions leaves it until the sign-in ends.
      if (
        (yield* accounts.attempts).some(
          (attempt) => attempt.profileId === undefined || attempt.profileId === profile.profileId,
        )
      )
        return yield* fail(
          "denied",
          "The user is signing in on this tab. Wait for scient_account_sign_in.",
        );
      const raw = yield* invoke<unknown>("accountCookies", { urls: [input.url] }, opened.tabId);
      const cookies = yield* decodeCookies(raw).pipe(
        Effect.mapError(() => fail("unavailable", "The browser session could not be read.")),
      );
      const jar = yield* Effect.try({
        try: () => netscapeCookieJar(cookies),
        catch: () => fail("unsupported", "The browser session contains an unsupported cookie."),
      });
      yield* accounts.authorizeUse(scope, target);
      if (granted)
        yield* accounts.authorizeUse(
          scope,
          { type: "account", accountId: granted.accountId },
          { since: granted, origin: new URL(input.url).origin },
        );
      const name = `${profile.profileId}-cookies`;
      const paths = yield* files.issue(yield* files.begin(scope.threadId), grants, [
        [`${name}.txt`, jar],
        [
          `${name}.json`,
          yield* encodeCookies(cookies).pipe(
            Effect.mapError(() => fail("unavailable", "The browser session could not be encoded.")),
          ),
        ],
      ]);
      const jarPath = paths[0]!;
      return {
        paths,
        usage: `curl --cookie ${shellQuote(jarPath)} ${shellQuote(new URL(input.url).origin)}; Python: import http.cookiejar, requests; jar = http.cookiejar.MozillaCookieJar(${shellQuote(jarPath)}); jar.load(ignore_discard=True); requests.get(${shellQuote(new URL(input.url).origin)}, cookies=jar)`,
      };
    });
    return yield* operation.pipe(
      Effect.onExit((exit) =>
        Effect.all(
          [
            accounts.recordUse({
              target,
              action: "browser-session",
              threadId: scope.threadId,
              ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
              outcome: exit._tag === "Success" ? "ok" : "error",
            }),
            ...(account
              ? [
                  accounts.recordUse({
                    target: { type: "account", accountId: account.accountId },
                    action: "browser-session",
                    threadId: scope.threadId,
                    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
                    outcome: exit._tag === "Success" ? "ok" : "error",
                  }),
                ]
              : []),
          ],
          { discard: true },
        ),
      ),
    );
  }, withCardAllowance),
  scient_account_add: addAccount,
  scient_connector_setup: setUpConnector,
  scient_connector_list: listConnectors,
  scient_connector_add: addConnector,
  scient_connector_control: controlConnector,
  scient_connector_copy: copyConnector,
  scient_connector_check: checkConnector,
  scient_connector_save: saveConnector,
  scient_paper_get: getPaper,
  scient_papers_queue: queuePapers,
  scient_papers_status: paperStatus,
} satisfies Parameters<typeof ScientAccountsToolkit.toLayer>[0];
type ToolInput<K extends keyof typeof ScientAccountsToolkit.tools> = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)[K]["parametersSchema"]
>;

/**
 * What applies to this session's use of an account, with why: the account's access in this
 * project and conversation, and for a website the browser profile that holds its session.
 */
const effectiveAccess = Effect.fn("AccountsAgent.effectiveAccess")(function* (
  account: AccountSummary,
  session: { readonly profiles: ReadonlyArray<BrowserProfileRecord> },
  scope: AccountSessionScope,
) {
  const accounts = yield* AccountsService;
  const decided = yield* accounts.peek(scope, { type: "account", accountId: account.accountId });
  if (decided.decision === "denied") return { effective: "off", why: "Off for agents" } as const;
  const profileId = account.details.kind === "website" ? account.details.profileId : undefined;
  if (profileId !== undefined) {
    const profile = session.profiles.find((item) => item.profileId === profileId);
    // Listed profiles are this session's: one missing is out of its project, or folded away.
    if (profile === undefined || profile.access === "off")
      return { effective: "off", why: "Its browser profile is off for agents here" } as const;
    const byProfile = yield* accounts.peek(scope, { type: "profile", profileId });
    if (byProfile.decision === "ask" && decided.decision === "allowed")
      return { effective: "ask", why: "Its browser profile asks the user first" } as const;
  }
  return decided.decision === "ask"
    ? ({ effective: "ask", why: "Asks the user first" } as const)
    : ({ effective: "allowed" } as const);
});

/**
 * The user's own sign-in to a row, beside their conversation: it runs on after the reply, which
 * names the tab as soon as it opens, in the service's scope, so shutdown interrupts it.
 */
const signInAsPerson = Effect.fn("AccountsAgent.signInAsPerson")(function* (
  scope: Scope.Scope,
  input: AccountSignInAsPersonInput,
  environmentId: EnvironmentId,
) {
  const accounts = yield* AccountsService;
  const account = (yield* accounts.snapshot).accounts.find(
    (row) => row.accountId === input.accountId,
  );
  if (account?.details.kind !== "website")
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "Choose a website or university to sign in to.",
    });
  const opened = yield* Deferred.make<PreviewTabId>();
  const services = yield* Effect.context<
    AccountsService | FileSystem.FileSystem | Path.Path | PreviewAutomationBroker
  >();
  const signing = yield* guardedSignIn({
    signIn: account,
    ...(input.tabId ? { page: { tabId: input.tabId } } : {}),
    caller: {
      kind: "person",
      afterSignIn: continueWaitingPapers(environmentId, account.accountId).pipe(
        Effect.provideContext(services),
      ),
      ...(input.discardIfUnfinished ? { discardIfUnfinished: true } : {}),
    },
    onTab: (tabId) => Deferred.succeed(opened, tabId).pipe(Effect.asVoid),
  }).pipe(
    Effect.onExit((exit) => recordSignInEnd(account.accountId, exit)),
    Effect.provideService(AgentInvocationContext, userRunInvocation(input.threadId, environmentId)),
    Effect.forkIn(scope),
  );
  const tabId = yield* Deferred.await(opened).pipe(
    Effect.raceFirst(
      Fiber.join(signing).pipe(
        Effect.flatMap((ended) =>
          Effect.fail(
            new AccountsError({
              reason: "unavailable",
              message:
                ("message" in ended && ended.message) || "The browser could not open the sign-in.",
            }),
          ),
        ),
      ),
    ),
  );
  return { tabId, threadId: input.threadId };
});

/** The person's own sign-ins, and what they type in one Scient runs, for the server's life. */
export class AccountAgentService extends Context.Service<
  AccountAgentService,
  {
    readonly signInAsPerson: (
      input: AccountSignInAsPersonInput,
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      { readonly tabId: PreviewTabId; readonly threadId: ThreadId },
      AccountsError,
      PreviewAutomationBroker | FileSystem.FileSystem | Path.Path
    >;
    readonly keepTyped: (input: AccountKeepTypedInput) => Effect.Effect<{ readonly kept: boolean }>;
  }
>()("t3/scient/accounts/agent/AccountAgentService") {}

export const layer = Layer.effect(
  AccountAgentService,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const accounts = yield* AccountsService;
    // A kept sign-in ends with its tab, however the tab went: the browser's closed event says so.
    const previews = yield* Effect.serviceOption(PreviewManager);
    if (Option.isSome(previews))
      yield* settleKeptOnClose(yield* previews.value.subscribeEvents).pipe(
        Effect.provideService(AccountsService, accounts),
        Effect.forkScoped,
      );
    return AccountAgentService.of({
      signInAsPerson: Effect.fn("AccountAgentService.signInAsPerson")(function* (
        input: AccountSignInAsPersonInput,
        environmentId: EnvironmentId,
      ) {
        return yield* signInAsPerson(scope, input, environmentId).pipe(
          Effect.provideService(AccountsService, accounts),
        );
      }),
      keepTyped: Effect.fn("AccountAgentService.keepTyped")(function* (
        input: AccountKeepTypedInput,
      ) {
        return yield* keepTyped(input).pipe(Effect.provideService(AccountsService, accounts));
      }),
    });
  }),
);
