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
import { isGoogleSessionRow } from "./AccountDecisions.ts";
import { AccountsService } from "./AccountsService.ts";
import { browserFailure, previewInvoker } from "./agent/broker.ts";
import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import {
  OPEN_ATHENS_CHECK_PAGE,
  openAthensCheckScript,
  signInReturn,
  universityDetails,
  universitySignInLink,
  usesOpenAthens,
} from "@t3tools/shared/scientPaperLinks";
import { AccountCookies } from "./agent/cookies.ts";
import { classifyProfilePage } from "./agent/profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./agent/profileDetection.ts";
import { guardedSignIn } from "./agent/guardedSignIn.ts";

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
const CHECK_THREAD = ThreadId.make("scient-accounts-check");

const run = Semaphore.makeUnsafe(1);

/** Full checks, one at a time; a second press is told one is already running. */
const fullRun = Semaphore.makeUnsafe(1);

/** A glance trusts a look this recent. An unchanged look writes nothing, so `signIn.at` can't tell. */
const GLANCE_FRESH_MS = 2 * 60 * 1000;
/** When this server last got a clear answer about each account. */
const lookedAt = new Map<AccountId, number>();

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

const openAthensUniversity = (account: Pick<AccountSummary, "details">) => {
  const institution = universityDetails(account.details)?.institution;
  return institution !== undefined && usesOpenAthens(institution);
};

/**
 * Where the account's session shows. Many sign-in pages stay up for a signed-in user. OpenAthens
 * says itself whether the person is signed in, so its universities are asked there, and no
 * journal is involved.
 */
export const checkAddress = (account: AccountSummary) => {
  const { details } = account;
  if (openAthensUniversity(account)) return OPEN_ATHENS_CHECK_PAGE;
  const university = universityDetails(details);
  if (university) return universitySignInLink(university);
  if (details.kind !== "website") return undefined;
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

const lookOnce = Effect.fn("AccountsCheck.one")(function* (
  listed: AccountSummary,
  url: string,
  observeOnly: boolean,
) {
  const accounts = yield* AccountsService;
  // A run can take minutes, and an agent's result since then decides whether to sign in.
  const account =
    (yield* accounts.snapshot).accounts.find((item) => item.accountId === listed.accountId) ??
    listed;
  const broker = yield* PreviewAutomationBroker;
  const scope = yield* AgentInvocationContext;
  const invoke = previewInvoker(broker, scope, {
    updateCurrentTab: false,
    mapError: browserFailure("The browser could not open this site."),
  });
  // A tab without a profile is a throwaway session, so name the one the account lives in.
  const browser = yield* invoke<PreviewAutomationStatus>("status", {});
  const opened = yield* invoke<PreviewAutomationStatus>("open", {
    url,
    profileId:
      ("profileId" in account.details ? account.details.profileId : undefined) ??
      browser.defaultProfileId ??
      DEFAULT_BROWSER_PROFILE_ID,
    open: false,
    reuseExistingTab: false,
  });
  const tabId = opened.tabId;
  if (!tabId)
    return yield* new AccountsError({
      reason: "unavailable",
      message: "No browser tab is available.",
    });
  const tabs = new Set<PreviewTabId>([tabId]);
  return yield* Effect.gen(function* () {
    yield* invoke("accountWaitForLoad", {}, tabId);
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
      };
    });
    const openAthens = openAthensUniversity(account);
    const { state, identity } = openAthens
      ? { state: yield* askOpenAthens(invoke, tabId), identity: undefined }
      : yield* readPage;
    if (keepsLastSeen(account, state)) return state;
    // Check is the user's own press: a signed-out sign-in with a saved password gets one attempt.
    if (state !== "signed-out" || account.secrets.password === undefined || observeOnly) {
      yield* accounts.recordCheck(account.accountId, {
        state,
        ...(state === "signed-in" && identity ? { username: identity } : {}),
        ...(state === "unknown"
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
      caller: { kind: "check" },
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
    return state;
  }).pipe(
    Effect.ensuring(
      Effect.forEach(tabs, (tab) => invoke("close", {}, tab).pipe(Effect.ignore), {
        discard: true,
      }),
    ),
  );
});

/** A look that couldn't tell earns no skip, so the next glance asks again. */
const checkOne = (account: AccountSummary, url: string, observeOnly = false) =>
  lookOnce(account, url, observeOnly).pipe(
    Effect.tap((state) =>
      state === "unknown"
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.map((now) => void lookedAt.set(account.accountId, now)),
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
  if (!account || url === undefined) return 0;
  const now = yield* Clock.currentTimeMillis;
  const last = lookedAt.get(accountId);
  if (last !== undefined && now - last < GLANCE_FRESH_MS) return 0;
  return yield* checkOne(account, url, true).pipe(
    Effect.as(1),
    Effect.orElseSucceed(() => 0),
  );
});

const runCheck = Effect.fn("AccountsCheck.run")(function* (input: AccountsCheckInput) {
  const accounts = yield* AccountsService;
  const snapshot = yield* accounts.snapshot;
  const chosen = snapshot.accounts
    .filter((account) =>
      input.accountId === undefined
        ? worthChecking(account)
        : account.accountId === input.accountId,
    )
    // Google says itself whether these work (`accounts.googleSessions.seen`).
    .filter((account) => !isGoogleSessionRow(account))
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
  return chosen.length;
});

/** One account looked at now, in a hidden tab, for a sign-in that just finished. */
export const checkAccountNow = (account: AccountSummary, environmentId: EnvironmentId) => {
  const url = checkAddress(account);
  return url === undefined
    ? Effect.void
    : checkOne(account, url).pipe(
        Effect.provideService(
          AgentInvocationContext,
          userRunInvocation(CHECK_THREAD, environmentId),
        ),
      );
};

type CheckResult = { readonly checked: number; readonly alreadyRunning?: boolean };

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
          Effect.map((checked): CheckResult => ({ checked })),
        );
  // A press waits behind a glance, which is short; only another full check turns it away.
  return runCheck(input).pipe(
    Effect.provideService(AgentInvocationContext, invocation),
    run.withPermits(1),
    fullRun.withPermitsIfAvailable(1),
    Effect.map(
      Option.match({
        onNone: (): CheckResult => ({ checked: 0, alreadyRunning: true }),
        onSome: (checked): CheckResult => ({ checked }),
      }),
    ),
  );
};
