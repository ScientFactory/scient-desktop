// @effect-diagnostics nodeBuiltinImport:off -- Opaque attempt ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountId,
  type AccountKeepTypedInput,
  type AccountSignInAttempt,
  type AccountSignInOutcome,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import { attemptKey, signInsForPage } from "@t3tools/shared/scientAccountSignIn";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import type { PaperRequester } from "../../papers/paperAttempt.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import {
  authorizationDecision,
  siteMatches as siteMatchesOrigin,
  signedInMomentsAgo,
  signInHeld,
  siteLimiting,
} from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { checkAccountNow } from "../checkAccounts.ts";
import type { SignInSubmission } from "../signIn/decision.ts";
import { SignInDetection, signInDetectionScript } from "../signIn/detection.ts";
import { signIn, type SignInOptions } from "../signIn/engine.ts";
import { closeLeftovers, withSignInService } from "../universitySignIn.ts";
import { authorize } from "./accountUse.ts";
import { previewInvoker } from "./broker.ts";
import { signInCodes } from "./signInCodes.ts";

const decodeDetection = Schema.decodeUnknownEffect(SignInDetection);
const isAccountsError = Schema.is(AccountsError);

/** Who asked for a sign-in. `check` is the user's own press; the others never lift a hold. */
export type SignInCaller =
  | { readonly kind: "agent"; readonly scope: AccountSessionScope }
  | { readonly kind: "page"; readonly scope: AccountSessionScope }
  | { readonly kind: "check" }
  | {
      readonly kind: "paper";
      readonly scope: AccountSessionScope;
      readonly requester: Pick<PaperRequester, "accounts">;
    }
  /** The user's own press, in the invocation's thread: they see the tab and finish what's left. */
  | {
      readonly kind: "person";
      /** A row made just for this sign-in goes again if nothing comes of it. */
      readonly discardIfUnfinished?: boolean;
      /** After a sign-in that worked: papers waiting for it go on. */
      readonly afterSignIn?: Effect.Effect<void>;
    };

/** How one attempt on one row ended. */
export interface SignInAttempt {
  readonly outcome: AccountSignInOutcome;
  readonly message?: string;
  readonly tabId?: PreviewTabId;
  readonly accountId?: AccountId;
  /** The tab waits at a second factor as the site's pending attempt: leave it open. */
  readonly pending?: true;
}

export type SignInResult =
  | SignInAttempt
  /** `find` matched several saved sign-ins; the caller picks one. */
  | { readonly outcome: "choose"; readonly accounts: ReadonlyArray<AccountSummary> }
  /** `find` matched none. */
  | { readonly outcome: "none" };

interface SignInRequest {
  readonly page?: { readonly tabId?: PreviewTabId | undefined; readonly url?: string };
  /** Told the attempt's tab as soon as it has one. */
  readonly onTab?: (tabId: PreviewTabId) => Effect.Effect<void>;
  /** The tab's profile, which `find` matches in; Main otherwise. */
  readonly profileId?: string | undefined;
  readonly signIn: AccountSummary | { readonly find: string };
  readonly caller: SignInCaller;
}

const signInLocks = new Map<string, Semaphore.Semaphore>();
const lockFor = (key: string) => {
  const known = signInLocks.get(key);
  if (known) return known;
  const lock = Semaphore.makeUnsafe(1);
  signInLocks.set(key, lock);
  return lock;
};

const automatic = (caller: SignInCaller) => caller.kind === "page" || caller.kind === "paper";
const userPress = (caller: SignInCaller) => caller.kind === "check" || caller.kind === "person";

/** A person has fifteen minutes, looked at often enough to close a university's return at once. */
const PERSON = { waitMs: 15 * 60_000, lookGapMs: 400 };
const MOST_PENDING = 4;

type Invocation = AgentInvocationContext["Service"];

/**
 * An attempt stopped at a second factor, kept with its tab and what it submitted, so the next
 * press or agent call in its thread resumes it instead of typing the password again. In memory:
 * a restart ends it.
 */
interface Pending {
  readonly attemptId: string;
  readonly accountId: AccountId;
  readonly invocation: Invocation;
  readonly tabId: PreviewTabId;
  readonly submissions: ReadonlyArray<SignInSubmission>;
  readonly submittedAt?: number | undefined;
}
const pendingAttempts = new Map<string, Pending>();

/**
 * What one attempt saw, and what the user typed in its tab, in order. A candidate is kept only for
 * an origin that asked for a password and never asked again after it (a rejected password brings
 * the field back), where Scient didn't type the password itself, and only after the sign-in is
 * proven. Values stay here until kept or dropped.
 */
interface Typed {
  readonly threadId: string;
  readonly tabId: PreviewTabId;
  readonly sites: ReadonlyArray<string>;
  readonly university: boolean;
  readonly fields: Set<string>;
  /** When each origin last showed a password field, in the order of `seen`. */
  readonly passwordSeen: Map<string, number>;
  readonly scientTyped: Set<string>;
  readonly candidates: Map<
    string,
    {
      readonly username: string;
      readonly password: Redacted.Redacted<string>;
      readonly at: number;
    }
  >;
  seen: number;
  readonly arrived: Deferred.Deferred<void>;
  readonly accountId: AccountId;
  accepted?: ReadonlySet<string>;
}
const typedIn = new Map<string, Typed>();
/** After a proven sign-in, how long the first typed password may take to arrive, then a late one. */
const FIRST_CANDIDATE = "3 seconds";
const LATE_CANDIDATE = "10 seconds";

/** Origins whose last typed password the site moved on from: no password field came back. */
const acceptedOrigins = (typed: Typed) =>
  new Set(
    [...typed.passwordSeen].flatMap(([origin, at]) =>
      !typed.scientTyped.has(origin) && (typed.candidates.get(origin)?.at ?? -1) > at
        ? [origin]
        : [],
    ),
  );

/** Ends an attempt: its tab opens to agents again and anything typed in it is dropped. */
const endAttempt = Effect.fn("AccountsAgent.endAttempt")(function* (attemptId: string) {
  typedIn.delete(attemptId);
  yield* (yield* AccountsService).removeAttempt(attemptId);
});

const keepCandidate = Effect.fn("AccountsAgent.keepCandidate")(function* (typed: Typed) {
  const accepted = typed.accepted ?? new Set<string>();
  const candidate = [...accepted].flatMap((origin) => typed.candidates.get(origin) ?? [])[0];
  if (!candidate) return false;
  typed.candidates.clear();
  return (yield* (yield* AccountsService).keepTyped(typed.accountId, candidate)) === "kept";
});

/** The user's typing in a sign-in Scient runs, from the desktop's capture of that tab. */
export const keepTyped = Effect.fn("AccountsAgent.keepTyped")(function* (
  input: AccountKeepTypedInput,
) {
  const typed = typedIn.get(input.attemptId);
  if (!typed || typed.threadId !== input.threadId || typed.tabId !== input.tabId)
    return { kept: false };
  const origin = URL.canParse(input.origin) ? new URL(input.origin).origin : "";
  const onSite = typed.university
    ? origin.startsWith("https://") && typed.fields.has(origin)
    : siteMatchesOrigin(typed.sites, origin);
  if (!onSite) return { kept: false };
  const candidate = {
    username: input.username,
    password: Redacted.make(input.password),
    at: typed.seen++,
  };
  // A late one, after the sign-in was proven: its page asked for a password and nothing since.
  if (typed.accepted) {
    if (!typed.passwordSeen.has(origin) || typed.scientTyped.has(origin)) return { kept: false };
    typed.candidates.set(origin, candidate);
    typed.accepted = new Set([origin]);
    return { kept: yield* keepCandidate(typed) };
  }
  typed.candidates.set(origin, candidate);
  yield* Deferred.succeed(typed.arrived, undefined);
  return { kept: true };
});

/**
 * After a proven sign-in: the password typed on the accepted page is kept once it arrives, within
 * a few seconds, and a late one is still taken for a few more. True when it holds the attempt open
 * for that.
 */
const drainTyped = Effect.fn("AccountsAgent.drainTyped")(function* (
  attemptId: string,
  draining: Effect.Effect<void>,
) {
  const typed = typedIn.get(attemptId);
  // Only a password field the person faced can have a typed password to keep.
  if (!typed || [...typed.passwordSeen.keys()].every((origin) => typed.scientTyped.has(origin)))
    return false;
  // The capture of the last step can come after the page that proved it.
  if (acceptedOrigins(typed).size === 0)
    yield* Deferred.await(typed.arrived).pipe(Effect.timeout(FIRST_CANDIDATE), Effect.ignore);
  typed.accepted = acceptedOrigins(typed);
  if (yield* keepCandidate(typed)) return false;
  yield* draining;
  yield* Effect.sleep(LATE_CANDIDATE).pipe(
    Effect.andThen(endAttempt(attemptId)),
    Effect.forkDetach,
  );
  return true;
});

const browserOf = Effect.fn("AccountsAgent.browserOf")(function* (invocation: Invocation) {
  const broker = yield* PreviewAutomationBroker;
  return previewInvoker(broker, invocation, { updateCurrentTab: false });
});

/** Ends a kept attempt and closes its tab. */
const dropPending = Effect.fn("AccountsAgent.dropPending")(function* (key: string) {
  const kept = pendingAttempts.get(key);
  if (!kept) return;
  pendingAttempts.delete(key);
  yield* endAttempt(kept.attemptId);
  const invoke = yield* browserOf(kept.invocation);
  yield* invoke("close", {}, kept.tabId).pipe(Effect.ignore);
});

/** The kept attempt this caller may resume: its tab is open, in this thread, past the password. */
const resumable = Effect.fn("AccountsAgent.resumable")(function* (
  key: string,
  caller: SignInCaller,
  invocation: Invocation,
) {
  const kept = pendingAttempts.get(key);
  const mayResume =
    caller.kind === "person" || (caller.kind === "agent" && !caller.scope.unattended);
  if (!kept || !mayResume || kept.invocation.threadId !== invocation.threadId) return undefined;
  const invoke = yield* browserOf(kept.invocation);
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, kept.tabId).pipe(
    Effect.option,
  );
  if (!Option.getOrUndefined(status)?.tabs?.some((tab) => tab.tabId === kept.tabId))
    return undefined;
  // Back at the password form, the site started over: for a press that is a fresh attempt.
  const page = yield* invoke<unknown>(
    "evaluate",
    { expression: signInDetectionScript },
    kept.tabId,
  ).pipe(Effect.flatMap(decodeDetection), Effect.option);
  const restarted =
    Option.isSome(page) && page.value.password !== null && !page.value.otp && !page.value.challenge;
  return restarted && caller.kind === "person" ? undefined : kept;
});

/** Whether Scient may resolve this row's stored password and 2FA key for this caller now. */
const mayType = Effect.fn("AccountsAgent.mayType")(function* (
  caller: SignInCaller,
  account: AccountSummary,
  agentAccess: boolean,
) {
  const unattended = { projectId: undefined, unattended: true };
  switch (caller.kind) {
    case "agent":
      // Ask waits for the user's card; Off and out of scope refuse.
      yield* authorize(caller.scope, { type: "account", accountId: account.accountId }, "sign-in");
      return true;
    case "page":
      return (
        authorizationDecision(agentAccess, account.controls, caller.scope).decision === "allowed"
      );
    case "paper":
      // The user's own request may use any sign-in that isn't Off; an agent's needs it Allowed.
      return caller.requester.accounts === "all"
        ? account.controls.access !== "off"
        : authorizationDecision(agentAccess, account.controls, unattended).decision === "allowed";
    case "check":
    case "person":
      return account.controls.access !== "off";
  }
});

type Needs = AccountsService | PreviewAutomationBroker | AgentInvocationContext;

/**
 * The one way into the sign-in engine: one attempt per real site and identity at a time, across
 * duplicate rows and universities sharing an identity provider. Each attempt reads Accounts afresh
 * inside the lock. A hold is checked first and leaves the record alone: recording a blocked
 * attempt would replace the result that caused it.
 */
const run = Effect.fn("AccountsAgent.guardedSignIn")(function* (
  request: SignInRequest,
): Effect.fn.Return<SignInResult, AccountsError, Needs> {
  const accounts = yield* AccountsService;
  let account: AccountSummary;
  if ("find" in request.signIn) {
    const { accounts: rows } = yield* accounts.snapshot;
    const { caller } = request;
    const usable =
      caller.kind === "paper" && caller.requester.accounts !== "all"
        ? rows.filter((row) => caller.requester.accounts.includes(row.accountId))
        : rows;
    const fitting = signInsForPage(
      usable,
      request.signIn.find,
      request.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
    );
    if (fitting.length === 0) return { outcome: "none" } satisfies SignInResult;
    if (fitting.length > 1) return { outcome: "choose", accounts: fitting } satisfies SignInResult;
    account = fitting[0]!;
  } else account = request.signIn;
  return yield* attempt(request, account.accountId).pipe(
    lockFor(attemptKey(account) ?? account.accountId).withPermits(1),
  );
});

/** A named row only ever gives an attempt's outcome; `find` can also give `choose` or `none`. */
export function guardedSignIn(
  request: SignInRequest & { readonly signIn: AccountSummary },
): Effect.Effect<SignInAttempt, AccountsError, Needs>;
export function guardedSignIn(
  request: SignInRequest,
): Effect.Effect<SignInResult, AccountsError, Needs>;
export function guardedSignIn(request: SignInRequest) {
  return run(request);
}

const attempt = Effect.fn("AccountsAgent.signInAttempt")(function* (
  request: Pick<SignInRequest, "page" | "caller" | "onTab">,
  accountId: AccountId,
) {
  const { caller } = request;
  const accounts = yield* AccountsService;
  const invocation = yield* AgentInvocationContext;
  const { accounts: rows, agentAccess } = yield* accounts.snapshot;
  const account = rows.find((row) => row.accountId === accountId);
  if (!account)
    return { outcome: "failed", message: "The account no longer exists." } satisfies SignInAttempt;
  const key = attemptKey(account) ?? account.accountId;
  const newest = rows
    .filter((row) => (attemptKey(row) ?? row.accountId) === key)
    .flatMap((row) => (row.signIn ? [row.signIn] : []))
    .toSorted((a, b) => b.at.localeCompare(a.at))[0];
  const now = yield* Clock.currentTimeMillis;
  if (siteLimiting({ signIn: newest }, now))
    return {
      outcome: "limited",
      message: "The site is limiting access from this network. Try again in an hour.",
    } satisfies SignInAttempt;
  if (automatic(caller) && signedInMomentsAgo(account, now))
    return {
      outcome: "failed",
      message: `${account.name} signed in moments ago, so something keeps ending it. Scient won't repeat it by itself.`,
    } satisfies SignInAttempt;
  const resume = yield* resumable(key, caller, invocation);
  const held = !userPress(caller) && !resume && signInHeld(newest);
  // A person can still finish a held sign-in by hand; Scient types nothing into it.
  const handOver = held && caller.kind === "agent" && !caller.scope.unattended;
  if (held && !handOver)
    return {
      outcome: "failed",
      message: `${account.name}'s last sign-in didn't go through, so Scient won't repeat it by itself.`,
    } satisfies SignInAttempt;
  const permitted = yield* mayType(caller, account, agentAccess);
  if (!permitted && caller.kind !== "person")
    return {
      outcome: "needs-user",
      message: `${account.name}'s access doesn't let Scient type its saved password here.`,
    } satisfies SignInAttempt;
  // A new attempt on the site ends the one waiting there.
  if (!resume) yield* dropPending(key);
  const session =
    "scope" in caller
      ? caller.scope
      : {
          threadId: invocation.threadId,
          projectId: undefined,
          unattended: caller.kind !== "person",
        };
  const attemptId = resume?.attemptId ?? NodeCrypto.randomUUID();
  const university = universityDetails(account.details);
  const arrived = yield* Deferred.make<void>();
  const register = (tabId: PreviewTabId, state: AccountSignInAttempt["state"]) =>
    Effect.suspend(() => {
      if (!typedIn.has(attemptId) && account.details.kind === "website")
        typedIn.set(attemptId, {
          threadId: invocation.threadId,
          tabId,
          sites: account.details.sites,
          university: university !== undefined,
          fields: new Set(),
          passwordSeen: new Map(),
          scientTyped: new Set(),
          candidates: new Map(),
          seen: 0,
          arrived,
          accountId: account.accountId,
        });
      return accounts.setAttempt({
        attemptId,
        threadId: invocation.threadId,
        tabId,
        accountId: account.accountId,
        state,
      });
    });
  const options: SignInOptions = {
    ...(caller.kind === "agent" ? yield* signInCodes(session, account) : {}),
    ...(automatic(caller) ? { stopAtCode: true } : {}),
    ...(caller.kind === "agent" || caller.kind === "page" ? {} : { userRun: true }),
    ...(caller.kind === "person"
      ? { person: { ...PERSON, learnOrigins: university !== undefined } }
      : {}),
    ...(resume ? { resume } : {}),
    onTab: (tabId) =>
      register(tabId, caller.kind === "person" ? "person" : "typing").pipe(
        Effect.andThen(request.onTab?.(tabId) ?? Effect.void),
      ),
    onPage: (page) => {
      const typed = typedIn.get(attemptId);
      if (!typed) return;
      if (page.fields) typed.fields.add(page.origin);
      if (page.password) typed.passwordSeen.set(page.origin, typed.seen++);
    },
    onTyped: (origin) => typedIn.get(attemptId)?.scientTyped.add(origin),
  };
  const target = { type: "account", accountId: account.accountId } as const;
  const where = {
    threadId: session.threadId,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  };
  const result = yield* Effect.gen(function* () {
    const values =
      handOver || resume || !permitted
        ? {}
        : yield* accounts.resolveSecrets(account.accountId, ["password", "totp"]);
    const ran = yield* signIn(
      session,
      account,
      values,
      resume?.tabId ?? request.page?.tabId,
      options,
    );
    return yield* withEvidence(account, ran, invocation);
  }).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Success"
        ? accounts.recordUse(
            {
              target,
              action: "sign-in",
              ...where,
              signInOutcome: exit.value.outcome,
              outcome: exit.value.outcome === "signed-in" ? "ok" : "error",
              ...("savedPasswordUsed" in exit.value ? { savedPasswordUsed: true } : {}),
            },
            "message" in exit.value ? exit.value.message : undefined,
            true,
          )
        : accounts
            .recordUse({ target, action: "sign-in", ...where, outcome: "error" }, undefined, true)
            .pipe(Effect.andThen(endAttempt(attemptId))),
    ),
    // A locked store or a full browser says nothing about the sign-in, so no outcome is recorded.
    Effect.catch((error) =>
      endAttempt(attemptId).pipe(
        Effect.as({
          outcome: "failed",
          message: isAccountsError(error)
            ? error.message
            : "The browser sign-in could not be completed.",
        } satisfies SignInAttempt),
      ),
    ),
  );
  if (!("tabId" in result)) return result;
  const kept = "pending" in result ? result.pending : undefined;
  if (kept) {
    // One kept attempt per site and identity, and a few in all: the oldest gives way.
    const oldest =
      pendingAttempts.size >= MOST_PENDING ? pendingAttempts.keys().next().value : undefined;
    if (oldest !== undefined && oldest !== key) yield* dropPending(oldest);
    pendingAttempts.delete(key);
    pendingAttempts.set(key, {
      attemptId,
      accountId: account.accountId,
      invocation,
      tabId: result.tabId,
      submissions: kept.submissions,
      submittedAt: kept.submittedAt,
    });
    yield* register(result.tabId, "pending");
  } else {
    if (pendingAttempts.get(key)?.attemptId === attemptId) pendingAttempts.delete(key);
    // Verified first, then recorded, then kept: only a proven sign-in keeps what was typed.
    const draining =
      result.outcome === "signed-in" &&
      (yield* drainTyped(attemptId, register(result.tabId, "draining")));
    if (!draining) yield* endAttempt(attemptId);
  }
  if (caller.kind === "person")
    yield* result.outcome === "signed-in"
      ? epilogue(account, result, invocation, caller.afterSignIn)
      : discardUnfinished(account.accountId, caller.discardIfUnfinished);
  return {
    outcome: result.outcome,
    tabId: result.tabId,
    accountId: account.accountId,
    ...("message" in result && result.message !== undefined ? { message: result.message } : {}),
    ...(kept ? { pending: true as const } : {}),
  } satisfies SignInAttempt;
});

/**
 * Only authenticated evidence counts as signed in. The engine's own needs a sign-out control or
 * an identity tag; a university's needs its link back, then a check that reaches the journal, and
 * a library link that it came back after the person typed on the way.
 */
const withEvidence = Effect.fn("AccountsAgent.withEvidence")(function* <
  A extends {
    readonly outcome: AccountSignInOutcome;
    readonly learned?: ReadonlyArray<string>;
    readonly savedPasswordUsed?: true;
  },
>(account: AccountSummary, ran: A, invocation: Invocation) {
  const university = universityDetails(account.details);
  if (ran.outcome !== "signed-in" || !university) return ran;
  let confirmed: boolean;
  if (university.institution) {
    const checked = {
      ...account,
      details: { ...university, sites: withSignInService(university.sites, new Set(ran.learned)) },
    };
    yield* checkAccountNow(checked, invocation.environmentId).pipe(Effect.ignore);
    const seen = (yield* (yield* AccountsService).snapshot).accounts.find(
      (row) => row.accountId === account.accountId,
    );
    confirmed = seen?.signIn?.state === "signed-in";
  } else confirmed = (ran.learned?.length ?? 0) > 0 || ran.savedPasswordUsed === true;
  return confirmed
    ? ran
    : ({ ...ran, outcome: "needs-user", message: "Couldn't confirm the sign-in." } as A);
});

/** After a person's sign-in worked: the university's return tab and earlier tries close. */
const epilogue = Effect.fn("AccountsAgent.signInEpilogue")(function* (
  account: AccountSummary,
  result: { readonly tabId: PreviewTabId; readonly learned?: ReadonlyArray<string> },
  invocation: Invocation,
  afterSignIn: Effect.Effect<void> | undefined,
) {
  const accounts = yield* AccountsService;
  const invoke = yield* browserOf(invocation);
  const university = universityDetails(account.details);
  if (university) {
    yield* invoke("close", {}, result.tabId).pipe(Effect.ignore);
    const current = (yield* accounts.snapshot).accounts.find(
      (row) => row.accountId === account.accountId,
    );
    const details = current && universityDetails(current.details);
    if (current && details) {
      const sites = withSignInService(details.sites, new Set(result.learned));
      if (sites.join("\n") !== details.sites.join("\n"))
        yield* accounts
          .save({
            accountId: current.accountId,
            name: current.name,
            details: { ...details, sites },
            secrets: {},
          })
          .pipe(Effect.ignore);
      yield* closeLeftovers(
        invoke,
        { accountId: current.accountId, details: { ...details, sites } },
        yield* accounts.attempts,
        result.tabId,
      );
    }
  }
  if (afterSignIn) yield* afterSignIn;
});

/** A row made just for an unfinished sign-in goes, while it still holds nothing. */
const discardUnfinished = Effect.fn("AccountsAgent.discardUnfinished")(function* (
  accountId: AccountId,
  discard: boolean | undefined,
) {
  if (!discard) return;
  const accounts = yield* AccountsService;
  const row = (yield* accounts.snapshot).accounts.find((item) => item.accountId === accountId);
  if (row && Object.keys(row.secrets).length === 0 && row.signIn?.state !== "signed-in")
    yield* accounts.remove(accountId).pipe(Effect.ignore);
});
