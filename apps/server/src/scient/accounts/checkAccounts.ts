import { UNKNOWN_RUN } from "./taskPinRules.ts";
import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountId,
  ProviderInstanceId,
  ThreadId,
  type AccountSignInState,
  type AccountSummary,
  type AccountsCheckInput,
  type EnvironmentId,
  type PreviewAutomationError,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { isGoogleSessionRow, signedOutOnPurpose } from "./AccountDecisions.ts";
import { AccountsService } from "./AccountsService.ts";
import { browserFailure, previewInvoker } from "./agent/broker.ts";
import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import {
  OPEN_ATHENS_CHECK_PAGE,
  openAthensCheckScript,
  signInReturn,
  universityDetails,
  universitySignInLink,
  openAthensUniversity,
} from "@t3tools/shared/scientPaperLinks";
import { AccountCookies } from "./agent/cookies.ts";
import { classifyProfilePage } from "./agent/profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./agent/profileDetection.ts";
import { guardedSignIn } from "./agent/guardedSignIn.ts";
import { mayAskCode, personActive } from "./signInCodes.ts";
import { nameAfterInstitution } from "./universityNames.ts";
import { glanceKey } from "@t3tools/shared/scientUniversityGroups";

const MAX_CHECKED = 40;
const PAUSE_MS = 1_500;
/** A university's sign-in service answers with a page that posts itself onward. */
const UNIVERSITY_LOOKS = 12;
const STEADY_LOOKS = 4;
/** OpenAthens' quiet ask goes to its sign-in service and back, which takes a few seconds. */
const OPEN_ATHENS_WAIT = "15 seconds";

const decodePage = Schema.decodeUnknownEffect(ProfileDetection);
const decodeCookies = Schema.decodeUnknownEffect(AccountCookies);

/** The user's own check is not an agent's use, so it runs under its own identity. */
export const CHECK_THREAD = ThreadId.make("scient-accounts-check");

const run = Semaphore.makeUnsafe(1);

/** Full checks, one at a time; a second press is told one is already running. */
const fullRun = Semaphore.makeUnsafe(1);

/** A glance trusts a look this recent. An unchanged look writes nothing, so `signIn.at` can't tell. */
const GLANCE_FRESH_MS = 2 * 60 * 1000;
/** When this server last got a clear answer for each membership, route and profile. */
const lookedAt = new Map<string, number>();

/** The browser identity of something the user asked for, which is no agent's run. */
export const userRunInvocation = (threadId: ThreadId, environmentId: EnvironmentId) => ({
  environmentId,
  threadId,
  providerSessionId: `user-run:${threadId}`,
  providerInstanceId: ProviderInstanceId.make("scient"),
  capabilities: new Set(["preview", "accounts"] as const),
  issuedAt: 0,
});

const siteUrl = (site: string) => (site.startsWith("https://") ? site : `https://${site}`);

const openAthensRow = (account: Pick<AccountSummary, "details">) => {
  const university = universityDetails(account.details);
  return university !== undefined && openAthensUniversity(university);
};

/** Microsoft's sign-in hosts, for work or school accounts and for personal ones. */
const MICROSOFT_WORK =
  /^(?:https:\/\/)?(?:login\.microsoftonline\.com|login\.windows\.net|(?:[\w-]+\.)?office\.com|(?:[\w-]+\.)?microsoft365\.com|myaccount\.microsoft\.com)(?:\/|$)/iu;
const MICROSOFT_PERSONAL =
  /^(?:https:\/\/)?(?:login\.live\.com|account\.live\.com|account\.microsoft\.com)(?:\/|$)/iu;

/**
 * Where the account's session shows. Many sign-in pages stay up for a signed-in user. OpenAthens
 * says itself whether the person is signed in, so its universities are asked there, and no
 * journal is involved. A Microsoft account's sign-in page always lists it, so its own account page
 * is asked: it opens signed in, or sends the visitor to sign in, and the visit keeps it alive.
 */
export const checkAddress = (account: AccountSummary) => {
  const { details } = account;
  if (openAthensRow(account)) return OPEN_ATHENS_CHECK_PAGE;
  const university = universityDetails(details);
  if (university) return universitySignInLink(university);
  if (details.kind !== "website") return undefined;
  if (details.sites.some((site) => MICROSOFT_WORK.test(site)))
    return "https://myaccount.microsoft.com/";
  if (details.sites.some((site) => MICROSOFT_PERSONAL.test(site)))
    return "https://account.microsoft.com/";
  const site = details.sites[0];
  return site === undefined ? details.loginUrl : siteUrl(site);
};

/** Sign-ins with a known history. Imported password lists are checked one at a time, on request. */
export const worthChecking = (account: AccountSummary) =>
  checkAddress(account) !== undefined &&
  (universityDetails(account.details) !== undefined ||
    account.secrets.password === undefined ||
    account.lastUsedAt !== undefined ||
    account.signIn !== undefined);

/**
 * Only a link that came back counts. A directory link goes to the university's sign-in service on
 * any network, so coming back means that session is alive. A library link may be waved through by
 * the network alone, unless it came back on the library's own address.
 */
const universitySessionState = (
  details: NonNullable<ReturnType<typeof universityDetails>>,
  page: ProfileDetection,
): AccountSignInState => {
  if (page.deniedText) return "unknown";
  const back = signInReturn(page.finalUrl);
  if (back) return details.institution || back === "proxied" ? "signed-in" : "unknown";
  if (!URL.canParse(page.finalUrl)) return "unknown";
  const stopped = new URL(page.finalUrl);
  return page.passwordField ||
    anySiteMatches(details.sites, page.finalUrl) ||
    isIdentityPage(stopped) ||
    isLoginPlace(stopped)
    ? "signed-out"
    : "unknown";
};

export function sessionState(
  account: Pick<AccountSummary, "details" | "signIn" | "secrets">,
  url: string,
  page: ProfileDetection,
  hasSessionCookie: boolean,
): AccountSignInState {
  const { details } = account;
  if (page.limited) return "limited";
  const university = universityDetails(details);
  if (university) return universitySessionState(university, page);
  const result = classifyProfilePage(url, page);
  if (result === "sign-in") return "signed-out";
  if (result !== "opens") return "unknown";
  if (page.signOutLink) return "signed-in";
  if (page.signInLink) return "signed-out";
  // Anonymous visitors get protected cookies too, so one proves nothing about a new sign-in.
  const knownSession =
    account.signIn?.state === "signed-in" || account.secrets.password === undefined;
  return hasSessionCookie && knownSession ? "signed-in" : "unknown";
}

/** A check that can't tell leaves a university's last known state, with the date it was seen. */
const keepsLastSeen = (account: AccountSummary, state: AccountSignInState) =>
  state === "unknown" &&
  universityDetails(account.details) !== undefined &&
  account.signIn?.state === "signed-in";

/** OpenAthens' own answer, read from its page in the person's profile once its quiet ask is back. */
const askOpenAthens = Effect.fn("AccountsCheck.openAthens")(function* (
  invoke: <A>(
    operation: "evaluate",
    input: unknown,
    tabId?: PreviewTabId,
  ) => Effect.Effect<A, AccountsError>,
  tabId: PreviewTabId,
) {
  const looks = Effect.gen(function* () {
    for (;;) {
      // A look during a page change fails; the next one reads the page that came.
      const answer = yield* invoke<unknown>(
        "evaluate",
        { expression: openAthensCheckScript },
        tabId,
      ).pipe(Effect.orElseSucceed(() => "wait"));
      if (answer === "signed-in") return "signed-in" as const;
      if (answer === "signed-out") return "signed-out" as const;
      yield* Effect.sleep("300 millis");
    }
  });
  // One deadline for the whole ask, so a browser that stops answering can't hold other checks.
  return yield* looks.pipe(
    Effect.timeoutOption(OPEN_ATHENS_WAIT),
    Effect.map(Option.getOrElse(() => "unknown" as const)),
  );
});

/** The browser reached nothing: DNS, TLS, refused or timed out (its `navigation_network`). */
const navigationFailed = (error: PreviewAutomationError) =>
  error._tag === "PreviewAutomationExecutionError" &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  "detail" in error.cause &&
  typeof error.cause.detail === "object" &&
  error.cause.detail !== null &&
  "failureClass" in error.cause.detail &&
  error.cause.detail.failureClass === "navigation_network";

/**
 * What a look may do when it finds the row signed out: nothing, or one sign-in for this caller.
 * `task`: renewal's look for a run that needs the row now, which may sign in with nobody there.
 */
type AfterLook = "look" | "check" | "renewal" | "task";

const lookOnce = Effect.fn("AccountsCheck.one")(function* (
  listed: AccountSummary,
  url: string,
  after: AfterLook,
  forSignIn = false,
  /** Renewal's look with nobody there: its profile and evidence, never a sign-in. */
  lookOnly = false,
  /** This visit's own reach, apart from what the row keeps: a stale university row stays signed in. */
  visit: { unreachable: boolean } = { unreachable: false },
  /** The pinned scheduled task a `task` look is for. */
  taskId?: string,
) {
  const accounts = yield* AccountsService;
  // A run can take minutes, and an agent's result since then decides whether to sign in.
  const account =
    (yield* accounts.snapshot).accounts.find((item) => item.accountId === listed.accountId) ??
    listed;
  // Opening its sign-in link could sign the person back in through their identity provider. Only
  // the look that confirms their own Sign in goes there.
  if (!forSignIn && signedOutOnPurpose(account.signIn)) return "signed-out" as const;
  const broker = yield* PreviewAutomationBroker;
  const scope = yield* AgentInvocationContext;
  const invoke = previewInvoker(broker, scope, {
    updateCurrentTab: false,
    mapError: browserFailure("The browser could not open this site."),
  });
  // A tab without a profile is a throwaway session, so name the one the account lives in.
  const browser = yield* invoke<PreviewAutomationStatus>("status", {});
  // Read again right before opening it: a Sign out may have come while the browser answered.
  const now = (yield* accounts.snapshot).accounts.find(
    (item) => item.accountId === account.accountId,
  );
  if (!forSignIn && signedOutOnPurpose(now?.signIn)) return "signed-out" as const;
  // A page the network couldn't reach fails the open itself: that row is unreachable, not signed out.
  const opened = yield* previewInvoker(broker, scope, {
    updateCurrentTab: false,
  })<PreviewAutomationStatus>("open", {
    url,
    // A university with no profile of its own lives in Main, where its sign-in opens too; renewal
    // looks where its sign-out check looked: the row's profile, else Main.
    profileId:
      ("profileId" in account.details ? account.details.profileId : undefined) ??
      (universityDetails(account.details) || after === "renewal" || after === "task"
        ? undefined
        : browser.defaultProfileId) ??
      DEFAULT_BROWSER_PROFILE_ID,
    open: false,
    reuseExistingTab: false,
  }).pipe(
    Effect.map((status): PreviewAutomationStatus | undefined => status),
    Effect.catch((error) =>
      navigationFailed(error)
        ? Effect.undefined
        : Effect.fail(browserFailure("The browser could not open this site.")(error)),
    ),
  );
  if (opened === undefined) {
    visit.unreachable = true;
    if (!keepsLastSeen(account, "unknown"))
      yield* accounts.recordCheck(account.accountId, {
        state: "unknown",
        unreachable: true,
        detail: "Couldn't reach the site from this computer.",
      });
    return "unknown" as const;
  }
  const tabId = opened.tabId;
  if (!tabId)
    return yield* new AccountsError({
      reason: "unavailable",
      message: "No browser tab is available.",
    });
  const tabs = new Set<PreviewTabId>([tabId]);
  return yield* Effect.gen(function* () {
    // A page that never loads was never reached: not a sign-out, whatever the session holds.
    const loaded = yield* invoke("accountWaitForLoad", {}, tabId).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!loaded) {
      visit.unreachable = true;
      if (!keepsLastSeen(account, "unknown"))
        yield* accounts.recordCheck(account.accountId, {
          state: "unknown",
          unreachable: true,
          detail: "Couldn't reach the site from this computer.",
        });
      return "unknown" as const;
    }
    const look = invoke<unknown>("evaluate", { expression: profileDetectionScript }, tabId).pipe(
      Effect.flatMap(decodePage),
    );
    const readPage = Effect.gen(function* () {
      let page: ProfileDetection | undefined;
      if (universityDetails(account.details)) {
        let steady = 0;
        for (let turn = 0; turn < UNIVERSITY_LOOKS; turn++) {
          const seen = yield* look.pipe(Effect.option);
          const next = Option.getOrUndefined(seen);
          steady = next && next.finalUrl === page?.finalUrl ? steady + 1 : 0;
          page = next ?? page;
          if (next && (signInReturn(next.finalUrl) || next.passwordField || steady >= STEADY_LOOKS))
            break;
          yield* invoke("accountWaitForLoad", { settleMs: 1000 }, tabId).pipe(Effect.ignore);
        }
      }
      page ??= yield* look;
      const cookies = yield* invoke<unknown>(
        "accountCookies",
        { urls: [page.finalUrl] },
        tabId,
      ).pipe(
        Effect.flatMap(decodeCookies),
        Effect.orElseSucceed(() => []),
      );
      return {
        state: sessionState(
          account,
          url,
          page,
          cookies.some((cookie) => cookie.httpOnly),
        ),
        identity: page.identity,
        // The browser's own error page: nothing reached the site, so nothing about the sign-in.
        unreachable: !/^https?:/u.test(page.finalUrl),
      };
    });
    const openAthens = openAthensRow(account);
    const { state, identity, unreachable } = openAthens
      ? { state: yield* askOpenAthens(invoke, tabId), identity: undefined, unreachable: false }
      : yield* readPage;
    if (unreachable) visit.unreachable = true;
    if (keepsLastSeen(account, state)) return state;
    // Renewal, asked again now: off, it only looks; with nobody at a window, so does a row that
    // may send a code.
    const quiet =
      after === "look" ||
      lookOnly ||
      (after === "renewal" &&
        (!(yield* accounts.renewAutomatically) ||
          (!(yield* personActive) &&
            mayAskCode((yield* accounts.signInFactors)[account.accountId]))));
    // Check is the user's own press: a signed-out sign-in with a saved password gets one attempt.
    if (state !== "signed-out" || account.secrets.password === undefined || quiet) {
      yield* accounts.recordCheck(account.accountId, {
        state,
        ...(state === "signed-in" && identity ? { username: identity } : {}),
        ...(state === "unknown" && unreachable
          ? { unreachable: true as const, detail: "Couldn't reach the site from this computer." }
          : state === "unknown"
            ? {
                detail: openAthens
                  ? "OpenAthens didn't answer."
                  : "Couldn't tell from the site's page.",
              }
            : {}),
        ...(state === "limited"
          ? { detail: "The site is limiting access from this network." }
          : {}),
      });
      return state;
    }
    const result = yield* guardedSignIn({
      page: { tabId },
      signIn: account,
      caller: after === "task" ? { kind: "renewal", task: taskId ?? UNKNOWN_RUN } : { kind: after },
    });
    // A sign-in waiting at a second factor keeps its tab, for the person to finish there.
    if (result.pending && result.tabId) tabs.delete(result.tabId);
    else if (result.tabId) tabs.add(result.tabId);
    // Nothing reached the site, so nothing else says what was seen here.
    else
      yield* accounts.recordCheck(account.accountId, {
        state,
        ...(result.message === undefined ? {} : { detail: result.message }),
      });
    // Where it stands now: signed in again, else what the look found.
    return result.outcome === "signed-in" ? ("signed-in" as const) : state;
  }).pipe(
    Effect.ensuring(
      Effect.forEach(tabs, (tab) => invoke("close", {}, tab).pipe(Effect.ignore), {
        discard: true,
      }),
    ),
  );
});

/** A look that couldn't tell earns no skip, so the next glance asks again. */
const checkOne = (
  account: AccountSummary,
  url: string,
  after: AfterLook = "check",
  forSignIn = false,
  lookOnly = false,
  visit?: { unreachable: boolean },
  taskId?: string,
) =>
  lookOnce(account, url, after, forSignIn, lookOnly, visit, taskId).pipe(
    Effect.tap((state) =>
      state === "unknown"
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.map((now) => void lookedAt.set(glanceKey(account), now)),
          ),
    ),
  );

/**
 * Opening a university's menu: reads its page and never signs in. A university this server looked
 * at in the last two minutes is skipped, whichever window asked; a failed look earns no skip.
 */
const runGlance = Effect.fn("AccountsCheck.glance")(function* (accountId: AccountId) {
  const accounts = yield* AccountsService;
  const account = (yield* accounts.snapshot).accounts.find((item) => item.accountId === accountId);
  const url = account && universityDetails(account.details) ? checkAddress(account) : undefined;
  if (!account || url === undefined) return { checked: 0 };
  yield* nameAfterInstitution(account);
  const now = yield* Clock.currentTimeMillis;
  const last = lookedAt.get(glanceKey(account));
  if (last !== undefined && now - last < GLANCE_FRESH_MS) return { checked: 0 };
  return yield* checkOne(account, url, "look").pipe(
    Effect.map((state) => ({ checked: 1, ...(state === "unknown" ? { unclear: true } : {}) })),
    Effect.orElseSucceed(() => ({ checked: 0, unclear: true })),
  );
});

const runCheck = Effect.fn("AccountsCheck.run")(function* (input: AccountsCheckInput) {
  const accounts = yield* AccountsService;
  const snapshot = yield* accounts.snapshot;
  // Google says itself whether these work (`accounts.googleSessions.seen`).
  const checkable = snapshot.accounts.filter(
    (account) => !isGoogleSessionRow(account) && checkAddress(account) !== undefined,
  );
  const chosen = checkable
    .filter((account) =>
      input.accountId === undefined
        ? worthChecking(account)
        : account.accountId === input.accountId,
    )
    // Least recently seen first, so repeated presses reach every row past the cap.
    .toSorted((a, b) => (a.signIn?.at ?? "").localeCompare(b.signIn?.at ?? ""))
    .slice(0, MAX_CHECKED);
  yield* Effect.forEach(
    chosen,
    (account, index) =>
      Effect.gen(function* () {
        const url = checkAddress(account);
        if (url === undefined) return;
        if (index > 0) yield* Effect.sleep(PAUSE_MS);
        yield* checkOne(account, url).pipe(
          Effect.catch((error) =>
            keepsLastSeen(account, "unknown")
              ? Effect.void
              : accounts.recordCheck(account.accountId, {
                  state: "unknown",
                  detail: error.message || "The browser could not open this site.",
                }),
          ),
        );
      }),
    { discard: true },
  );
  return {
    checked: chosen.length,
    ...(input.accountId === undefined && checkable.length > chosen.length
      ? { skipped: checkable.length - chosen.length }
      : {}),
  };
});

/**
 * One account looked at now, in a hidden tab, for a sign-in that just finished: what the look
 * found, and nothing more. It never signs in, so it can run inside that sign-in's own attempt.
 */
export const checkAccountNow = (account: AccountSummary, environmentId: EnvironmentId) => {
  const url = checkAddress(account);
  return url === undefined
    ? Effect.succeed<AccountSignInState>("unknown")
    : checkOne(account, url, "look", true).pipe(
        Effect.provideService(
          AgentInvocationContext,
          userRunInvocation(CHECK_THREAD, environmentId),
        ),
      );
};

/**
 * A quiet look at a university a paper is about to go through, where only a look can tell: an
 * OpenAthens university answers on its keep-alive visit instead. Skipped when one was just taken,
 * or while a check holds the browser, so a paper never waits on it.
 */
export const lookBeforeFetch = (account: AccountSummary, environmentId: EnvironmentId) => {
  const university = universityDetails(account.details);
  if (!university || openAthensUniversity(university)) return Effect.void;
  return runGlance(account.accountId).pipe(
    Effect.provideService(AgentInvocationContext, userRunInvocation(CHECK_THREAD, environmentId)),
    run.withPermitsIfAvailable(1),
    Effect.asVoid,
  );
};

/** Scient's own upkeep: no user press, so it signs in only as an automatic caller may. */
const RENEWAL_THREAD = ThreadId.make("scient-accounts-renewal");

/**
 * Renews one row as its due quiet visit: the look Check does, and if signed out, one sign-in that
 * respects every stop. What it found, or `undefined` when the browser couldn't be reached and
 * nothing was recorded. Waits behind a Check or glance, which share the browser's one look at a
 * time.
 */
export const renewAccount = (
  account: AccountSummary,
  environmentId: EnvironmentId,
  /** Only the look: a sign-in now could text the person a code nobody is there to expect. */
  lookOnly = false,
) => {
  const url = checkAddress(account);
  return url === undefined
    ? Effect.succeed<AccountSignInState | undefined>("unknown")
    : checkOne(account, url, "renewal", false, lookOnly).pipe(
        Effect.orElseSucceed((): AccountSignInState | undefined => undefined),
        Effect.provideService(
          AgentInvocationContext,
          userRunInvocation(RENEWAL_THREAD, environmentId),
        ),
        run.withPermits(1),
      );
};

export interface RunLook {
  readonly state: AccountSignInState;
  readonly unreachable: boolean;
}

/**
 * Before a pinned task's run: the renewal look in the row's own profile, which signs in once by
 * itself if signed out and nothing stops it. What this visit found, and whether it reached the
 * site; a browser that can't be reached reaches nothing.
 */
export const lookBeforeRun = (
  account: AccountSummary,
  environmentId: EnvironmentId,
  taskId: string,
) => {
  const url = checkAddress(account);
  // A Google row is what Google last said of it.
  if (isGoogleSessionRow(account))
    return Effect.succeed<RunLook>({
      state: account.signIn?.state ?? "unknown",
      unreachable: false,
    });
  if (url === undefined) return Effect.succeed<RunLook>({ state: "unknown", unreachable: false });
  const visit = { unreachable: false };
  return checkOne(account, url, "task", false, false, visit, taskId).pipe(
    Effect.map((state): RunLook => ({ state, unreachable: visit.unreachable })),
    Effect.orElseSucceed((): RunLook => ({ state: "unknown", unreachable: true })),
    Effect.provideService(AgentInvocationContext, userRunInvocation(RENEWAL_THREAD, environmentId)),
    run.withPermits(1),
  );
};

/**
 * An agent's Check: one look at a website in its own profile, which never signs in, as that
 * agent (its browser access applies), queued with the person's checks.
 */
export const lookAtAccount = (account: AccountSummary) => {
  const url = checkAddress(account);
  // Google answers for its own rows; a generic look at its pages would misread them.
  return url === undefined || isGoogleSessionRow(account)
    ? Effect.void
    : checkOne(account, url, "look").pipe(Effect.asVoid, run.withPermits(1));
};

type CheckResult = {
  readonly checked: number;
  readonly skipped?: number;
  readonly alreadyRunning?: boolean;
  readonly unclear?: boolean;
};

/**
 * Opens each browser sign-in in its own profile, one at a time, and keeps what it found on the
 * account. A signed-out account with a saved password gets one unattended sign-in; one the site
 * already rejected gets none. Runs only when the user asks; a glance only looks.
 */
export const checkAccounts = (input: AccountsCheckInput, environmentId: EnvironmentId) => {
  const invocation = userRunInvocation(CHECK_THREAD, environmentId);
  // A glance waits its turn, so every university gets one; its freshness is read once it runs.
  if (input.glance)
    return input.accountId === undefined
      ? Effect.succeed<CheckResult>({ checked: 0 })
      : runGlance(input.accountId).pipe(
          Effect.provideService(AgentInvocationContext, invocation),
          run.withPermits(1),
          Effect.map((glanced): CheckResult => glanced),
        );
  // A press waits behind a glance, which is short; only another full check turns it away.
  return runCheck(input).pipe(
    Effect.provideService(AgentInvocationContext, invocation),
    run.withPermits(1),
    fullRun.withPermitsIfAvailable(1),
    Effect.map(
      Option.match({
        onNone: (): CheckResult => ({ checked: 0, alreadyRunning: true }),
        onSome: (result): CheckResult => result,
      }),
    ),
  );
};
