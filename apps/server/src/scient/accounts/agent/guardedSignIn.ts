// @effect-diagnostics nodeBuiltinImport:off -- Opaque attempt ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import {
  AccountsError,
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountHandoff,
  type AccountId,
  type AccountKeepTypedInput,
  type AccountSignInAttempt,
  type AccountSignInOutcome,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewEvent,
  type PreviewTabId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  attemptKeys,
  signedOutOnPurpose,
  signInsForPage,
} from "@t3tools/shared/scientAccountSignIn";
import { loginCopies } from "@t3tools/shared/scientLoginIdentity";
import { accountHandoffInstruction } from "@t3tools/shared/scientSignInPage";
import { signOutHosts, universityMembership } from "@t3tools/shared/scientUniversityGroups";
import {
  openAthensUniversity,
  signInReturn,
  universityDetails,
} from "@t3tools/shared/scientPaperLinks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import type { PaperRequester } from "../../papers/paperAttempt.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import {
  agentAccessOff,
  authorizationDecision,
  siteMatches as siteMatchesOrigin,
  signedInMomentsAgo,
  signInHeld,
  siteLimiting,
} from "../AccountDecisions.ts";
import {
  AccountsService,
  type AccountSessionScope,
  type AccountUseScope,
} from "../AccountsService.ts";
import { checkAccountNow } from "../checkAccounts.ts";
import { MANAGED_DEVICE_MESSAGE, MANAGED_DEVICE_STEP } from "../signIn/decision.ts";
import {
  CODE_COMING,
  codeBoxes,
  factorSeen,
  mayAskCode,
  personActive,
  scientsCode,
} from "../signInCodes.ts";
import { SignInDetection, signInDetectionScript } from "../signIn/detection.ts";
import { signIn, type SignInOptions } from "../signIn/engine.ts";
import { closeLeftovers, withSignInService } from "../signInTabs.ts";
import { authorize } from "./accountUse.ts";
import { previewInvoker } from "./broker.ts";
import { keepPrivateUntil } from "../signIn/keepPrivate.ts";
import { signedOutHere, signedOutSince } from "../signOuts.ts";
import { signInCodes } from "./signInCodes.ts";
import { notePage, type Pending, type Typed } from "./signInAttempts.ts";
import { needsYou, personTimeLeft } from "./cardAllowance.ts";

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
      readonly requester: Pick<PaperRequester, "threadId">;
    }
  /** A local connector the user linked this sign-in to: signed in again, unattended, when it ends. */
  | { readonly kind: "connector"; readonly projectId?: ProjectId | undefined }
  /** Scient's upkeep; `task`: the look before that pinned scheduled task's run. */
  | { readonly kind: "renewal"; readonly task?: string }
  /** The user's own press, in the invocation's thread: they see the tab and finish what's left. */
  | {
      readonly kind: "person";
      /** The agent that asked the user to sign in (`scient_account_add`): its access applies. */
      readonly agent?: AccountSessionScope;
      /** Why the agent asked, for the card. */
      readonly reason?: string;
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
  /** That factor, so the person is told the step. */
  readonly factor?: Pick<AccountHandoff, "kind" | "via">;
  /** The person's part ended without them: they cancelled, or their time ran out. */
  readonly ended?: "cancelled" | "timed-out";
  /** It waits for a one-time code sent after this time. */
  readonly codeSince?: number;
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
  /** A code the agent read from its own mail, for the step that asks for one. */
  readonly code?: string | undefined;
}

const automatic = (caller: SignInCaller) =>
  caller.kind === "page" ||
  caller.kind === "paper" ||
  caller.kind === "connector" ||
  caller.kind === "renewal";
const userPress = (caller: SignInCaller) => caller.kind === "check" || caller.kind === "person";

/**
 * Where a late session's cookies are: each saved site once (an origin as saved, port included), a
 * university's as its membership's Sign out names them in the attempt tab's profile (`profile`,
 * else the row's), so Google, other shared providers and another membership's OpenAthens stay.
 */
const lateSessionUrls = (
  account: AccountSummary,
  all: ReadonlyArray<AccountSummary>,
  tabProfile: string | undefined,
) => {
  const membership = universityDetails(account.details)
    ? (universityMembership(all, account.accountId)?.rows ?? [account])
    : undefined;
  const profileOf = (row: AccountSummary) =>
    ("profileId" in row.details ? row.details.profileId : undefined) ?? DEFAULT_BROWSER_PROFILE_ID;
  const profile = tabProfile ?? profileOf(account);
  const sites = membership
    ? signOutHosts(
        membership,
        all.filter(
          (row) =>
            profileOf(row) === profile &&
            !membership.some((own) => own.accountId === row.accountId),
        ),
      )
    : account.details.kind === "website"
      ? account.details.sites
      : [];
  return sites
    .slice(0, 16)
    .map((site) => (site.startsWith("https://") ? `${new URL(site).origin}/` : `https://${site}/`));
};

/** How long a late session's tab waits for the person before Scient tries to close it again. */
const SIGNED_OUT_WAIT_MS = 180_000;

/** Scient signs in with nobody pressing anything: automatic callers and unattended agents. */
const byItself = (caller: SignInCaller) =>
  automatic(caller) || (caller.kind === "agent" && caller.scope.unattended);

/**
 * The person's own action, a click or tap carried with the request: their Check, or their Sign in.
 * An agent's add, or an agent in a chat they have open, is not one.
 */
const personAction = (caller: SignInCaller) =>
  caller.kind === "check" || (caller.kind === "person" && caller.agent === undefined);

/**
 * Why Scient may not start a sign-in, or fill one, by itself now: "Renew sign-ins automatically"
 * is off. Only the person's own action signs in then, a scheduled task's run included.
 */
export const switchedOffFor = Effect.fn("AccountsAgent.switchedOffFor")(function* (name: string) {
  const accounts = yield* AccountsService;
  if (yield* accounts.renewAutomatically) return undefined;
  return `Renew sign-ins automatically is off, so Scient didn't sign in to ${name}.`;
});

/** Nobody in a chat can answer this sign-in now; an agent's page leaves that to its agent. */
const nobodyToAsk = (caller: SignInCaller) =>
  caller.kind === "renewal" ||
  caller.kind === "paper" ||
  caller.kind === "connector" ||
  (caller.kind === "agent" && caller.scope.unattended);

/** A person has fifteen minutes, looked at often enough to close a university's return at once. */
const PERSON = { waitMs: 15 * 60_000, lookGapMs: 400 };
const MOST_PENDING = 4;
/** The longer of the 30 s a sent code's answer is waited for and the person's hand-off. */
const KEPT_FOR_MS = Math.max(30_000, PERSON.waitMs);
/** A connector's session that ends sooner than this after a sign-in is not signed in again. */
const CONNECTOR_SIGN_IN_PAUSE_MS = 2 * 60_000;

type Invocation = AgentInvocationContext["Service"];

/** The one password the sign-in followed, when the attempt shows no other way it could have gone. */
const typedCandidate = (typed: Typed) => {
  const { candidate } = typed;
  if (!candidate || typed.submitted !== 1) return undefined;
  const askedSince = [...typed.fieldsSeen].some(
    ([origin, at]) => origin !== candidate.origin && at > candidate.at,
  );
  return askedSince || (typed.passwordSeen.get(candidate.origin) ?? -1) > candidate.at
    ? undefined
    : candidate;
};

/** Ends an attempt: its tab opens to agents again and anything typed in it is dropped. */
const endAttempt = Effect.fn("AccountsAgent.endAttempt")(function* (attemptId: string) {
  (yield* (yield* AccountsService).signInAttempts).typed.delete(attemptId);
  yield* (yield* AccountsService).removeAttempt(attemptId);
});

/** The user's typing in a sign-in Scient runs, from the desktop's capture of that tab. */
export const keepTyped = Effect.fn("AccountsAgent.keepTyped")(function* (
  input: AccountKeepTypedInput,
) {
  const typed = (yield* (yield* AccountsService).signInAttempts).typed.get(input.attemptId);
  if (!typed || typed.threadId !== input.threadId || typed.tabId !== input.tabId)
    return { kept: false };
  const origin = URL.canParse(input.origin) ? new URL(input.origin).origin : "";
  // Scient's own typing is captured too; it is no person's submit. A different password the person
  // types on the same page, after Scient's was refused, is theirs.
  if (
    typed.scientTyped.get(origin)?.some((password) => Redacted.value(password) === input.password)
  )
    return { kept: false };
  // Every password the person submits counts, an identity provider's on the way included.
  typed.submitted++;
  if (typed.signedIn) return { kept: false };
  const onSite = typed.university
    ? origin.startsWith("https://") && typed.fieldsSeen.has(origin)
    : siteMatchesOrigin(typed.sites, origin);
  if (!onSite) return { kept: false };
  const document = typed.documents?.get(origin);
  typed.candidate = {
    origin,
    username: input.username,
    password: Redacted.make(input.password),
    at: typed.seen++,
    document,
    refusedBefore: document !== undefined && typed.refusals?.get(origin) === document,
  };
  typed.refusedBack = false;
  return { kept: true };
});

/** After a sign-in that worked, the password it followed, if any, is kept; the rest is dropped. */
const keepCandidate = Effect.fn("AccountsAgent.keepCandidate")(function* (attemptId: string) {
  const typed = (yield* (yield* AccountsService).signInAttempts).typed.get(attemptId);
  const candidate = typed && typedCandidate(typed);
  if (!typed || !candidate) return;
  yield* (yield* AccountsService).keepTyped(typed.accountId, candidate).pipe(Effect.ignore);
});

const browserOf = Effect.fn("AccountsAgent.browserOf")(function* (invocation: Invocation) {
  const broker = yield* PreviewAutomationBroker;
  return previewInvoker(broker, invocation, { updateCurrentTab: false });
});

/** A kept attempt whose code the site may still be answering. */
const withSite = (kept: Pending | undefined) =>
  kept?.submissions.some(({ unanswered }) => unanswered) === true;

/** Ends a kept attempt whose tab closed: nothing waits on it, and nothing else is closed. */
const settle = Effect.fn("AccountsAgent.settleKept")(function* (key: string) {
  const { pending } = yield* (yield* AccountsService).signInAttempts;
  const kept = pending.get(key);
  if (!kept) return;
  pending.delete(key);
  yield* endAttempt(kept.attemptId);
});

/** Ends the kept attempts of each tab the browser says closed, however it went. */
export const settleKeptOnClose = (events: PubSub.Subscription<PreviewEvent>) =>
  PubSub.take(events).pipe(
    Effect.flatMap((event) =>
      event.type !== "closed"
        ? Effect.void
        : Effect.gen(function* () {
            const { pending } = yield* (yield* AccountsService).signInAttempts;
            for (const [key, kept] of pending) if (kept.tabId === event.tabId) yield* settle(key);
          }),
    ),
    Effect.forever,
  );

/** Whether a kept attempt's tab is still open; one found closed is ended. Unknown counts as open. */
const stillOpen = Effect.fn("AccountsAgent.stillOpen")(function* (key: string) {
  const kept = (yield* (yield* AccountsService).signInAttempts).pending.get(key);
  if (!kept) return false;
  const invoke = yield* browserOf(kept.invocation);
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, kept.tabId).pipe(
    Effect.option,
  );
  if (Option.isNone(status) || shows(status.value, kept.tabId)) return true;
  yield* settle(key);
  return false;
});

/** A targeted status shows its tab, or that it has none (`tabId: null`, no `tabs`). */
const shows = (status: PreviewAutomationStatus, tabId: PreviewTabId) =>
  status.tabId === tabId || status.tabs?.some((tab) => tab.tabId === tabId) === true;

/**
 * A kept attempt past its age: its tab is closed first, and the attempt ends only once the browser
 * shows the tab gone. A close refused, under the person's control say, keeps the tab theirs.
 */
const expire = Effect.fn("AccountsAgent.expireKept")(function* (key: string, entry: Pending) {
  const { pending } = yield* (yield* AccountsService).signInAttempts;
  if (pending.get(key) !== entry) return;
  const invoke = yield* browserOf(entry.invocation);
  yield* invoke("close", {}, entry.tabId).pipe(Effect.ignore);
  yield* stillOpen(key);
});

/** Ends a kept attempt and closes its tab. */
const dropPending = Effect.fn("AccountsAgent.dropPending")(function* (key: string) {
  const { pending } = yield* (yield* AccountsService).signInAttempts;
  const kept = pending.get(key);
  if (!kept) return;
  pending.delete(key);
  yield* endAttempt(kept.attemptId);
  const invoke = yield* browserOf(kept.invocation);
  yield* invoke("close", {}, kept.tabId).pipe(Effect.ignore);
});

/** Ends the attempts kept at a second factor for these rows, closing their tabs: a Sign out. */
export const retirePendingAttempts = Effect.fn("AccountsAgent.retirePendingAttempts")(function* (
  accountIds: ReadonlyArray<AccountId>,
) {
  const { pending } = yield* (yield* AccountsService).signInAttempts;
  const keys = [...pending].filter(([, kept]) => accountIds.includes(kept.accountId));
  yield* Effect.forEach(keys, ([key]) => dropPending(key), { discard: true });
});

/** The kept attempt this caller may resume: its tab is open, in this thread, past the password. */
const resumable = Effect.fn("AccountsAgent.resumable")(function* (
  key: string,
  caller: SignInCaller,
  invocation: Invocation,
  code: string | undefined,
) {
  const kept = (yield* (yield* AccountsService).signInAttempts).pending.get(key);
  // An unattended agent resumes only to give the code it read; nobody else could answer.
  const mayResume =
    caller.kind === "person" ||
    (caller.kind === "agent" && (!caller.scope.unattended || code !== undefined));
  if (!kept || !mayResume || kept.invocation.threadId !== invocation.threadId) return undefined;
  // Never anyone's but the person's: a resume ends the attempt, and its tab's cover, as it fails.
  if (withSite(kept) && caller.kind !== "person") return undefined;
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
  switch (caller.kind) {
    case "agent":
      // Ask waits for the user's card; Off and out of scope refuse.
      yield* authorize(caller.scope, { type: "account", accountId: account.accountId }, "sign-in");
      return true;
    case "page":
      return (
        authorizationDecision(agentAccess, account.controls, caller.scope).decision === "allowed"
      );
    case "paper": {
      // The user's own request uses any sign-in: Off governs agents. An agent's uses one its
      // conversation may use without asking now, in its project, approvals it was given included.
      if (caller.requester.threadId === undefined) return true;
      const accounts = yield* AccountsService;
      const target = { type: "account" as const, accountId: account.accountId };
      return (yield* accounts.authorize(caller.scope, target, "sign-in")).decision === "allowed";
    }
    case "person":
      if (caller.agent) {
        yield* authorize(
          caller.agent,
          { type: "account", accountId: account.accountId },
          "sign-in",
        );
        return true;
      }
      // The person's own Sign in and Check: agent controls never stop them.
      return true;
    case "check":
      return true;
    case "renewal":
      return account.controls.access !== "off";
    case "connector":
      // The user linked it to the connector; the connector already checked Off and scope.
      return !agentAccessOff(agentAccess, account.controls.access);
  }
});

/**
 * Whose use the gate checks right before Scient types: an agent's (its own sign-in, its add, a page
 * or paper its conversation drives) or a connector's link. The person's own press has none.
 */
const gatedBy = (
  caller: SignInCaller,
): { readonly scope: AccountUseScope; readonly linked?: true } | undefined => {
  switch (caller.kind) {
    case "agent":
    case "page":
      return { scope: caller.scope };
    case "paper":
      return caller.requester.threadId === undefined ? undefined : { scope: caller.scope };
    case "person":
      return caller.agent === undefined ? undefined : { scope: caller.agent };
    case "connector":
      return { scope: { projectId: caller.projectId, unattended: true }, linked: true };
    case "check":
    case "renewal":
      return undefined;
  }
};

/** `mayType` without a card: what this caller may type now, for a copy it didn't ask about. */
const mayTypeQuietly = Effect.fn("AccountsAgent.mayTypeQuietly")(function* (
  caller: SignInCaller,
  account: AccountSummary,
  agentAccess: boolean,
) {
  const target = { type: "account" as const, accountId: account.accountId };
  const accounts = yield* AccountsService;
  switch (caller.kind) {
    case "agent":
      return (yield* accounts.peek(caller.scope, target)).decision === "allowed";
    case "person":
      return caller.agent === undefined
        ? true
        : (yield* accounts.peek(caller.agent, target)).decision === "allowed";
    case "paper":
      return caller.requester.threadId === undefined
        ? true
        : (yield* accounts.peek(caller.scope, target)).decision === "allowed";
    case "page":
    case "check":
    case "connector":
      return yield* mayType(caller, account, agentAccess);
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
    // An agent's paper never types into a sign-in that is Off; the rest is decided before typing.
    const usable =
      caller.kind === "paper" && caller.requester.threadId !== undefined
        ? rows.filter((row) => row.controls.access !== "off")
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
  const { accounts: rows } = yield* accounts.snapshot;
  const ended = yield* (yield* accounts.signInAttempts).exclusive(
    attemptKeys(rows)(account),
    attempt(request, account.accountId),
  );
  // Every attempt's end is traced, those that stop before a tab opens included. Never a value.
  yield* Effect.annotateCurrentSpan(
    "signIn.outcome",
    ("ended" in ended ? ended.ended : undefined) ?? ended.outcome,
  );
  return ended;
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
  request: Pick<SignInRequest, "page" | "caller" | "onTab" | "code">,
  accountId: AccountId,
  /** This attempt is the login's one fallback: another copy's password, after a refusal. */
  fallback = false,
): Effect.fn.Return<SignInAttempt, AccountsError, Needs> {
  const { caller } = request;
  const accounts = yield* AccountsService;
  const invocation = yield* AgentInvocationContext;
  const { typed: typedIn, pending: pendingAttempts } = yield* accounts.signInAttempts;
  const { accounts: rows, agentAccess } = yield* accounts.snapshot;
  const account = rows.find((row) => row.accountId === accountId);
  if (!account)
    return { outcome: "failed", message: "The account no longer exists." } satisfies SignInAttempt;
  const keyOf = attemptKeys(rows);
  const key = keyOf(account);
  const newest = rows
    .filter((row) => keyOf(row) === key)
    .flatMap((row) => (row.signIn ? [row.signIn] : []))
    .toSorted((a, b) => b.at.localeCompare(a.at))[0];
  const now = yield* Clock.currentTimeMillis;
  // During a limit Scient submits nothing; the person's own Sign in still opens the page by hand.
  const limiting = siteLimiting({ signIn: newest }, now);
  if (limiting && caller.kind !== "person")
    return {
      outcome: "limited",
      message: "The site is limiting access from this network. Try again in an hour.",
    } satisfies SignInAttempt;
  const endedTooSoon =
    caller.kind === "connector"
      ? // A connector retries each call once; only a session that ends right away is a loop.
        account.signIn?.state === "signed-in" &&
        now - Date.parse(account.signIn.at) < CONNECTOR_SIGN_IN_PAUSE_MS
      : signedInMomentsAgo(account, now);
  if (automatic(caller) && endedTooSoon)
    return {
      outcome: "failed",
      message: `${account.name} signed in moments ago, so something keeps ending it. Scient won't repeat it by itself.`,
    } satisfies SignInAttempt;
  const waiting = yield* resumable(key, caller, invocation, request.code);
  // The person's press on a tab they chose stays on that tab, not one an earlier attempt kept.
  const resume =
    caller.kind === "person" &&
    request.page?.tabId !== undefined &&
    waiting !== undefined &&
    waiting.tabId !== request.page.tabId
      ? undefined
      : waiting;
  const attended = caller.kind === "agent" && !caller.scope.unattended;
  // A refused password waits for a new one (`signInHeld`); only the person's press, or this
  // login's one fallback to another copy, tries again.
  const held =
    !fallback &&
    !userPress(caller) &&
    !resume &&
    signInHeld({ signIn: newest, secrets: account.secrets }, now, attended);
  // A person can still finish a held sign-in by hand; Scient types nothing into it.
  const handOver = held && attended;
  // Named, so whatever waits on this sign-in can ask the person for it.
  if (held && !handOver)
    return {
      outcome: "failed",
      message: `${account.name}'s last sign-in didn't go through${newest?.detail ? ` (${newest.detail})` : ""}, so Scient won't repeat it by itself.`,
      accountId: account.accountId,
    } satisfies SignInAttempt;
  // One session per account: signing in by itself would end the person's own, so they choose.
  if (
    byItself(caller) &&
    rows.some(
      (row) => keyOf(row) === key && row.details.kind === "website" && row.details.oneSession,
    )
  ) {
    if (nobodyToAsk(caller))
      yield* accounts
        .setNeedsYou({
          needId: `sign-in:${account.accountId}`,
          name: account.name,
          detail: "Waiting for you to sign in",
          action: "sign-in",
          accountId: account.accountId,
          threadId: invocation.threadId,
        })
        .pipe(Effect.ignore);
    return {
      outcome: "needs-user",
      message: `${account.name} keeps one session, so Scient won't sign in by itself and end yours. Sign in when you're done there.`,
      accountId: account.accountId,
    } satisfies SignInAttempt;
  }
  // Only the person's own Sign in brings back a university they signed out of.
  if (caller.kind !== "person" && signedOutOnPurpose(account.signIn))
    return {
      outcome: "needs-user",
      message: `${account.name} was signed out on purpose. Sign in from the Library to use it again.`,
      accountId: account.accountId,
    } satisfies SignInAttempt;
  // "Renew sign-ins automatically" off: only the person's own action signs in. A scheduled task's
  // run, renewal or a connector waits for them in Needs you; an agent's add still opens for the
  // person, typing nothing itself.
  const governed = !personAction(caller);
  const switchedOff = `Renew sign-ins automatically is off, so Scient didn't sign in to ${account.name}.`;
  const offAtStart = governed && !(yield* accounts.renewAutomatically);
  if (offAtStart && caller.kind !== "person") {
    if (nobodyToAsk(caller))
      yield* accounts
        .setNeedsYou({
          needId: `sign-in:${account.accountId}`,
          name: account.name,
          detail: "Waiting for you to sign in",
          action: "sign-in",
          accountId: account.accountId,
          threadId: invocation.threadId,
        })
        .pipe(Effect.ignore);
    return {
      outcome: "failed",
      message: switchedOff,
      accountId: account.accountId,
    } satisfies SignInAttempt;
  }
  // Noted before anything is sent: a sign-out from here on ends this sign-in, at every write.
  const signOutMark = yield* accounts.signOutSequence;
  // Where the person signed out on purpose, only they sign back in.
  if (byItself(caller) && (yield* signedOutHere(account).pipe(Effect.orElseSucceed(() => false))))
    return {
      outcome: "failed",
      message: `You signed out of ${account.name}, so Scient won't sign back in by itself.`,
      accountId: account.accountId,
    } satisfies SignInAttempt;
  const permitted = yield* mayType(caller, account, agentAccess);
  if (!permitted && caller.kind !== "person")
    return {
      outcome: "needs-user",
      message: `${account.name}'s access doesn't let Scient type its saved password here.`,
    } satisfies SignInAttempt;
  // A code the site may still be answering keeps its tab as it is: only the person starts over.
  if (
    !resume &&
    caller.kind !== "person" &&
    withSite(pendingAttempts.get(key)) &&
    (yield* stillOpen(key))
  )
    return {
      outcome: "needs-user",
      message: "Finish signing in on the site's page.",
      accountId: account.accountId,
    } satisfies SignInAttempt;
  // A new attempt on the site ends the one waiting there.
  if (!resume) yield* dropPending(key);
  // The person's own sign-in is newer than a sign-out of this row still clearing: it stops there.
  if (caller.kind === "person") yield* accounts.supersedeSignOuts(account.accountId);
  const session =
    "scope" in caller
      ? caller.scope
      : {
          threadId: invocation.threadId,
          projectId: caller.kind === "person" ? caller.agent?.projectId : undefined,
          unattended: caller.kind !== "person",
        };
  const attemptId = resume?.attemptId ?? NodeCrypto.randomUUID();
  const university = universityDetails(account.details);
  /** The attempt tab's profile, as the engine opened it. */
  let tabProfile: string | undefined;
  const tabProfileId = () =>
    tabProfile === undefined ? undefined : BrowserProfileId.make(tabProfile);
  const register = (tabId: PreviewTabId, state: AccountSignInAttempt["state"]) =>
    Effect.suspend(() => {
      if (!typedIn.has(attemptId) && account.details.kind === "website")
        typedIn.set(attemptId, {
          threadId: invocation.threadId,
          tabId,
          sites: account.details.sites,
          university: university !== undefined,
          accountId: account.accountId,
          fieldsSeen: new Map(),
          passwordSeen: new Map(),
          scientTyped: new Map(),
          submitted: 0,
          signedIn: false,
          seen: 0,
        });
      return accounts.setAttempt({
        attemptId,
        threadId: invocation.threadId,
        tabId,
        accountId: account.accountId,
        state,
        ...(tabProfile === undefined ? {} : { profileId: BrowserProfileId.make(tabProfile) }),
      });
    });
  // A sign-in Scient starts by itself may send a code: it says so first, published before anything
  // is typed, whenever the site has asked for one, or nobody is at a window to expect it. Upkeep
  // signs a quiet row in silently: a code step it meets anyway is explained then (`onCodeStep`).
  // If the notice can't be published, nothing is typed.
  const lastFactor = (yield* accounts.signInFactors)[account.accountId];
  const quietUpkeep = caller.kind === "renewal" && caller.task === undefined;
  const announced =
    byItself(caller) &&
    !handOver &&
    !resume &&
    permitted &&
    (mayAskCode(lastFactor) || (!quietUpkeep && !(yield* personActive)));
  /** The phone notices this sign-in left, each settled with how it ended. */
  const notices: string[] = [];
  /** Keeps a notice for the phone (`codeNotices`) and shows it in Needs you, or fails. */
  const tellPhone = (detail: string) =>
    accounts
      .addCodeNotice({ accountId: account.accountId, text: `${account.name}: ${detail}` })
      .pipe(
        Effect.tap((noticeId) => Effect.sync(() => void notices.push(noticeId))),
        Effect.andThen(
          accounts.setNeedsYou({
            needId: `sign-in:${account.accountId}`,
            name: account.name,
            detail,
            accountId: account.accountId,
            threadId: session.threadId,
          }),
        ),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Accounts: the code notice wasn't kept for the phone", {
            accountId: account.accountId,
            reason: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
  if (announced) {
    const published = yield* tellPhone(CODE_COMING);
    if (!published)
      return {
        outcome: "failed",
        message: `Scient couldn't tell you a code may come, so it didn't sign in to ${account.name}.`,
        accountId: account.accountId,
      } satisfies SignInAttempt;
  }
  const codes = yield* signInCodes(session, account, key);
  const gate = gatedBy(caller);
  let metCode = false;
  /** A code step no notice announced, explained the moment it appeared. */
  let noticed = false;
  /** The saved authenticator key answered a code step. */
  let typedKey = false;
  /** Every code box of the run and who filled it, apart from the one-shot notice. */
  const boxes = codeBoxes();
  const options: SignInOptions = {
    askCode: codes.askCode,
    // During a limit the person's sign-in is by hand: no code goes in without them.
    ...(limiting ? {} : { codes: codes.codes }),
    // The login's one fallback, shared with another copy's password and a paper's other route.
    fallback: () => accounts.takeFallback(key),
    attemptId,
    ...(byItself(caller) || governed
      ? {
          // Asked before each value Scient types and each submit: the one place a send starts.
          stillAllowed: Effect.gen(function* () {
            if (yield* endedBySignOut)
              return `You signed out of ${account.name}, so Scient won't sign back in by itself.`;
            if (governed && !(yield* accounts.renewAutomatically)) return switchedOff;
            // Upkeep of a row that may send a code goes on only while someone is still there.
            if (quietUpkeep && mayAskCode(lastFactor) && !(yield* personActive))
              return `Nobody is at Scient now, so it stopped signing in to ${account.name}: a code may come.`;
            return undefined;
          }),
        }
      : {}),
    ...(request.code === undefined || limiting ? {} : { agentCode: request.code }),
    // Offered on the hand-off; used only on the person's tap, whoever started the sign-in.
    ...(limiting ? {} : { backupCode: accounts.takeBackupCode(account.accountId) }),
    ...(caller.kind === "person" && caller.reason
      ? { reason: caller.reason }
      : handOver
        ? { reason: `${account.name}'s last sign-in didn't go through. Finish it here.` }
        : {}),
    ...(automatic(caller) ? { stopAtCode: true } : {}),
    // A page or connector waits inside an agent's call; the rest can wait for a code longer.
    ...(caller.kind === "page" || caller.kind === "connector" ? { codeWaitMs: 20_000 } : {}),
    ...(caller.kind === "agent" || caller.kind === "page" ? {} : { userRun: true }),
    ...(gate === undefined
      ? {}
      : {
          beforeType: (origin: string) =>
            accounts.authorizeUse(
              gate.scope,
              { type: "account", accountId: account.accountId },
              { since: account, origin, linked: gate.linked },
            ),
        }),
    ...(caller.kind === "person" && request.page?.tabId ? { personTab: true } : {}),
    ...(caller.kind === "agent" ? { handoffMs: yield* personTimeLeft } : {}),
    // Use saved is the person's own press: it types the saved password whatever agents may do,
    // though never while the site limits sign-ins.
    ...(limiting
      ? {}
      : {
          saved: accounts
            .resolveSecrets(accountId, ["password", "totp"])
            .pipe(Effect.orElseSucceed(() => ({}))),
        }),
    ...(caller.kind === "person"
      ? {
          person: {
            ...PERSON,
            // An agent's add waits only for what is left of its call.
            ...(caller.agent
              ? { waitMs: Math.max(Math.min(PERSON.waitMs, yield* personTimeLeft), 0) }
              : {}),
            learnOrigins: university !== undefined,
          },
        }
      : {}),
    ...(resume ? { resume } : {}),
    onTab: (tabId, profileId) => {
      tabProfile = profileId;
      return register(tabId, caller.kind === "person" ? "person" : "typing").pipe(
        Effect.andThen(request.onTab?.(tabId) ?? Effect.void),
      );
    },
    onPage: (page) => {
      const typed = typedIn.get(attemptId);
      if (!typed) return;
      if (page.fields) typed.fieldsSeen.set(page.origin, typed.seen);
      // The load the password was submitted from, seen again while it waits for the answer, asks
      // nothing new; a new load that brings the form back does, as does the form saying it
      // refused, unless it said so already when the password was submitted from it and hasn't
      // stopped since.
      const { candidate } = typed;
      const submittedFrom =
        candidate?.origin === page.origin &&
        page.document !== undefined &&
        candidate.document === page.document;
      const refusedNow = page.refused && !(submittedFrom && candidate?.refusedBefore === true);
      if (page.password && (!submittedFrom || refusedNow))
        typed.passwordSeen.set(page.origin, typed.seen);
      // Once the old refusal is gone, a refusal that shows again is this submission's.
      if (submittedFrom && candidate.refusedBefore && !page.refused)
        typed.candidate = { ...candidate, refusedBefore: false };
      typed.refusals ??= new Map();
      if (page.refused && page.document !== undefined)
        typed.refusals.set(page.origin, page.document);
      else typed.refusals.delete(page.origin);
      typed.seen++;
      notePage(typed, page, page.document);
    },
    onTyped: (origin, password) => {
      const typed = typedIn.get(attemptId);
      if (!typed) return;
      const passwords = typed.scientTyped.get(origin) ?? [];
      typed.scientTyped.set(origin, [...passwords, Redacted.make(password)]);
    },
    onSavedCode: () => void (typedKey = true),
    onCodeBox: boxes.note,
    ...(offAtStart && caller.kind === "person" ? { handsOff: true } : {}),
    onCodeStep: (kind) =>
      Effect.suspend(() => {
        if (kind === "sent") metCode = true;
        if (!byItself(caller) || announced || noticed) return Effect.succeed(true);
        noticed = true;
        // Before Scient tries the code it can find, and as the site sends it. Not kept for the
        // phone, nothing more is sent.
        return tellPhone(scientsCode(account.name));
      }),
    personRefused: () => typedIn.get(attemptId)?.refusedBack === true,
  };
  const target = { type: "account", accountId: account.accountId } as const;
  const where = {
    threadId: session.threadId,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  };
  /**
   * A sign-out of the site, recorded now or at any moment since the sign-in began, in the row's
   * profile or the tab's. Unreadable, it counts as one.
   */
  const endedBySignOut = Effect.gen(function* () {
    return (
      (yield* signedOutHere(account, tabProfileId())) ||
      (yield* signedOutSince(account, signOutMark, tabProfileId()))
    );
  }).pipe(
    Effect.provideService(AccountsService, accounts),
    Effect.orElseSucceed(() => true),
  );
  /** Kept off the row: a sign-in that finished after a sign-out. */
  let unrecorded = false;
  // What this attempt typed: a refusal is bound to that password, and a refused code that wasn't
  // the saved 2FA key's says nothing about what's saved.
  let submitted: { readonly passwordVersion?: string; readonly totp: boolean } = { totp: false };
  const result = yield* Effect.gen(function* () {
    const version = yield* accounts.passwordVersion(account.accountId);
    const values =
      handOver || resume || !permitted || limiting || offAtStart
        ? {}
        : yield* accounts.resolveSecrets(account.accountId, ["password", "totp"]);
    submitted = {
      ...(values.password !== undefined && version !== undefined
        ? { passwordVersion: version }
        : {}),
      totp: values.totp !== undefined,
    };
    const ran = yield* signIn(
      session,
      account,
      values,
      resume?.tabId ?? request.page?.tabId,
      options,
    );
    const typed = typedIn.get(attemptId);
    if (typed && ran.outcome === "signed-in") typed.signedIn = true;
    if (ran.outcome === "signed-in") yield* codes.codes.worked;
    const seen = yield* withEvidence(account, ran, invocation, tabProfile);
    // The person signed out while Scient was signing in by itself: their sign-out stands, and a
    // session the late answer left in the tab's jar goes with the tab.
    if (byItself(caller) && (yield* endedBySignOut)) {
      unrecorded = true;
      if (account.details.kind === "website") {
        const browser = yield* browserOf(invocation);
        // The tab's jar is the one cleared, so its profile says which sessions are another's.
        const urls = lateSessionUrls(account, (yield* accounts.snapshot).accounts, tabProfile);
        const done = <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        const clear = done(browser("accountClearCookies", { urls }, ran.tabId));
        const close = done(browser("close", {}, ran.tabId));
        // Cleared, then again once answers still on the way have landed, then closed. Any step that
        // fails keeps the tab private and the person's, and is tried again.
        const ended = Effect.gen(function* () {
          if (!(yield* clear)) return false;
          yield* browser("accountWaitForLoad", { settleMs: 1000 }, ran.tabId).pipe(Effect.ignore);
          return (yield* clear) && (yield* close);
        });
        yield* keepPrivateUntil({
          tabId: ran.tabId,
          threadId: session.threadId,
          accountId: account.accountId,
          accountName: account.name,
          site: account.details.sites[0] ?? account.name,
          reason: "You signed out here while Scient was signing in. Close this tab.",
          waitMs: SIGNED_OUT_WAIT_MS,
          settle: ended,
          close: ended,
          show: browser(
            "open",
            { tabId: ran.tabId, reuseExistingTab: true, open: true },
            ran.tabId,
          ).pipe(Effect.ignore),
        }).pipe(Effect.provideService(AccountsService, accounts));
      }
      return {
        ...seen,
        outcome: "failed" as const,
        message: `You signed out of ${account.name}, so Scient won't sign back in by itself.`,
      };
    }
    return seen;
  }).pipe(
    Effect.ensuring(codes.codes.release),
    Effect.onExit((exit) =>
      exit._tag === "Success"
        ? accounts.recordUse(
            {
              target,
              action: "sign-in",
              ...where,
              ...(unrecorded || (exit.value.outcome === "code-rejected" && !submitted.totp)
                ? {}
                : { signInOutcome: exit.value.outcome }),
              outcome: exit.value.outcome === "signed-in" ? "ok" : "error",
              ...("savedPasswordUsed" in exit.value ? { savedPasswordUsed: true } : {}),
              ...(userPress(caller) ? { byPerson: true } : {}),
              ...(tabProfile === undefined ? {} : { profileId: BrowserProfileId.make(tabProfile) }),
              // Settled against the row the sign-in started from, inside the outcome's own write.
              version: account.updatedAt,
              // Bound to the saved password only as Scient typed it: a sign-in the person finished
              // with a password of their own says nothing of the saved one.
              ...(submitted.passwordVersion === undefined ||
              (exit.value.outcome === "signed-in" && !("savedPasswordUsed" in exit.value))
                ? {}
                : { passwordVersion: submitted.passwordVersion }),
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
  // An agent's sign-in the person didn't finish, or couldn't because nobody was there, waits on
  // its row for them, once.
  if (caller.kind === "agent" && result.outcome === "needs-user")
    yield* needsYou(target, caller.scope, "sign-in");
  // The phone keeps what it was told; a quick sign-in adds that it worked.
  for (const noticeId of notices)
    yield* accounts.settleCodeNotice(
      noticeId,
      result.outcome === "signed-in" ? "signed-in" : "not-signed-in",
    );
  if (!("tabId" in result)) return result;
  const other =
    !fallback && result.outcome === "password-rejected" && permitted && !handOver && !resume
      ? yield* otherPassword(account, rows, caller, agentAccess)
      : undefined;
  if (other && (yield* accounts.takeFallback(key))) {
    yield* endAttempt(attemptId);
    return yield* attempt({ ...request, page: { tabId: result.tabId } }, other, true);
  }
  let kept = "pending" in result ? result.pending : undefined;
  if (kept) {
    // One kept attempt per site and identity, and a few in all: the oldest gives way.
    const oldest =
      pendingAttempts.size >= MOST_PENDING
        ? [...pendingAttempts].find(([, waiting]) => !withSite(waiting))?.[0]
        : undefined;
    if (oldest !== undefined && oldest !== key) yield* dropPending(oldest);
    pendingAttempts.delete(key);
    const entry = {
      attemptId,
      accountId: account.accountId,
      invocation,
      tabId: result.tabId,
      submissions: kept.submissions,
      submittedAt: kept.submittedAt,
    };
    pendingAttempts.set(key, entry);
    yield* register(result.tabId, "pending");
    // Checked after the write: a close told meanwhile settled the entry, one before shows in the
    // tab's status. Either way it is not kept, and the record goes as the attempt ends.
    if (!(yield* stillOpen(key))) kept = undefined;
    // Never kept for good: past the person's hand-off its tab closes, and then it ends.
    else
      yield* Effect.sleep(KEPT_FOR_MS).pipe(Effect.andThen(expire(key, entry)), Effect.forkDetach);
  } else {
    if (pendingAttempts.get(key)?.attemptId === attemptId) pendingAttempts.delete(key);
    // Evidence first, then recorded, then kept: only a sign-in that worked keeps what was typed.
    if (result.outcome === "signed-in") yield* keepCandidate(attemptId);
  }
  const ended = "ended" in result ? result.ended : undefined;
  const finalUrl = yield* tabUrl(invocation, result.tabId);
  yield* Effect.annotateCurrentSpan({
    "signIn.outcome": ended ?? result.outcome,
    "signIn.route": routeKind(account),
    ...(finalUrl ? { "signIn.finalHost": new URL(finalUrl).host } : {}),
  });
  // The attempt stays registered until its tab closes, so the tab stays covered and closed to agents.
  const tidy =
    caller.kind !== "person"
      ? Effect.void
      : result.outcome === "signed-in"
        ? epilogue(account, result, invocation, caller.afterSignIn)
        : Effect.all([
            discardUnfinished(account.accountId, caller.discardIfUnfinished),
            kept ||
            !university ||
            (result.outcome === "needs-user" && !ended && !signInReturned(finalUrl))
              ? Effect.void
              : closeTab(invocation, result.tabId),
          ]).pipe(Effect.asVoid);
  yield* tidy.pipe(Effect.ensuring(kept ? Effect.void : endAttempt(attemptId)));
  // Only a sign-in seen from its first page says the site asks for no code; a continued one doesn't.
  // A key the site refused was answering a box that wasn't its own: that row may send a code.
  const keyRefused = typedKey && result.outcome === "code-rejected";
  // A code box the key wasn't known to answer, left to the person or a texted code, is a code too.
  const outsideBox = boxes.outside(result.outcome === "signed-in");
  const metAnyCode = metCode || outsideBox;
  if (metAnyCode || keyRefused || (result.outcome === "signed-in" && !resume && !handOver))
    yield* accounts.noteSignInFactor(
      account.accountId,
      factorSeen({
        sentCode: metCode,
        unknownBox: outsideBox,
        typedKey,
        outcome: result.outcome,
      }),
    );
  const needId = `sign-in:${account.accountId}`;
  if (result.outcome === "signed-in") yield* accounts.clearNeedsYou(needId).pipe(Effect.ignore);
  else if ((announced || noticed) && result.outcome !== "needs-user")
    yield* accounts.clearNeedsYou(needId).pipe(Effect.ignore);
  else if (result.outcome === "needs-user" && nobodyToAsk(caller)) {
    // A managed-device policy is the person's own browser's to pass; Sign in here can't.
    const managed = "message" in result && result.message === MANAGED_DEVICE_MESSAGE;
    yield* accounts
      .setNeedsYou({
        needId,
        name: account.name,
        detail: managed
          ? MANAGED_DEVICE_STEP
          : kept?.factor
            ? accountHandoffInstruction(kept.factor)
            : "Waiting for you to sign in",
        ...(managed ? {} : { action: "sign-in" as const }),
        accountId: account.accountId,
        threadId: session.threadId,
      })
      .pipe(Effect.ignore);
  }
  return {
    outcome: result.outcome,
    tabId: result.tabId,
    accountId: account.accountId,
    ...("message" in result && result.message !== undefined ? { message: result.message } : {}),
    ...(kept ? { pending: true as const, ...(kept.factor ? { factor: kept.factor } : {}) } : {}),
    ...(ended ? { ended } : {}),
    ...(kept?.code ? { codeSince: kept.submittedAt ?? (yield* Clock.currentTimeMillis) } : {}),
  } satisfies SignInAttempt;
});

/**
 * A copy of the same login (so under the same attempt lock) that this caller may type without
 * asking, whose password differs and wasn't refused: the login's one fallback.
 */
const otherPassword = Effect.fn("AccountsAgent.otherPassword")(function* (
  account: AccountSummary,
  rows: ReadonlyArray<AccountSummary>,
  caller: SignInCaller,
  agentAccess: boolean,
) {
  const accounts = yield* AccountsService;
  const copies: AccountSummary[] = [];
  for (const copy of loginCopies(rows, account.accountId))
    if (
      copy.signIn?.state !== "password-rejected" &&
      copy.secrets.password?.refusedAt === undefined &&
      (yield* mayTypeQuietly(caller, copy, agentAccess))
    )
      copies.push(copy);
  if (copies.length === 0) return undefined;
  const own = (yield* accounts.resolveSecrets(account.accountId, ["password"])).password;
  for (const copy of copies) {
    const value = yield* accounts
      .resolveSecrets(copy.accountId, ["password"])
      .pipe(Effect.orElseSucceed(() => ({ password: undefined })));
    if (value.password && (!own || Redacted.value(value.password) !== Redacted.value(own)))
      return copy.accountId;
  }
  return undefined;
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
>(account: AccountSummary, ran: A, invocation: Invocation, openedIn: string | undefined) {
  const university = universityDetails(account.details);
  if (ran.outcome !== "signed-in" || !university) return ran;
  // A fresh look at this route in the profile the sign-in opened in; a library link's typing on
  // the way counts too.
  const checked = {
    ...account,
    details: {
      ...university,
      sites: withSignInService(university.sites, new Set(ran.learned)),
      ...(openedIn === undefined ? {} : { profileId: BrowserProfileId.make(openedIn) }),
    },
  };
  // Its own answer, not the row: a look that couldn't tell leaves an older sign-in there.
  const seen = yield* checkAccountNow(checked, invocation.environmentId).pipe(
    Effect.orElseSucceed(() => "unknown" as const),
  );
  const confirmed =
    seen === "signed-in" ||
    (!university.institution && ((ran.learned?.length ?? 0) > 0 || ran.savedPasswordUsed === true));
  return confirmed
    ? ran
    : ({ ...ran, outcome: "needs-user", message: "Couldn't confirm the sign-in." } as A);
});

/** Which way a sign-in went, for traces: OpenAthens, the directory's, a library link, or the site. */
const routeKind = (account: AccountSummary) => {
  const university = universityDetails(account.details);
  if (!university) return "site";
  if (openAthensUniversity(university)) return "openathens";
  return university.institution ? "institution" : "library";
};

/** Where an attempt's tab ended up; nothing when the tab is gone. */
const tabUrl = Effect.fn("AccountsAgent.tabUrl")(function* (
  invocation: Invocation,
  tabId: PreviewTabId,
) {
  const invoke = yield* browserOf(invocation);
  const status = yield* invoke<PreviewAutomationStatus>("status", {}, tabId).pipe(Effect.option);
  const url = Option.getOrUndefined(status)?.tabs?.find((tab) => tab.tabId === tabId)?.url;
  return typeof url === "string" && URL.canParse(url) ? url : undefined;
});

/** The tab is on the publisher that asked for the sign-in, which the person never needs. */
const signInReturned = (url: string | undefined) =>
  url !== undefined && signInReturn(url) !== undefined;

const closeTab = Effect.fn("AccountsAgent.closeTab")(function* (
  invocation: Invocation,
  tabId: PreviewTabId,
) {
  const invoke = yield* browserOf(invocation);
  yield* invoke("close", {}, tabId).pipe(Effect.ignore);
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
