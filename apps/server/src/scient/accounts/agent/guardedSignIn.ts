import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountId,
  type AccountSignInOutcome,
  type AccountSummary,
  type PreviewTabId,
} from "@t3tools/contracts";
import { attemptKey, signInsForPage } from "@t3tools/shared/scientAccountSignIn";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { PaperRequester } from "../../papers/paperAttempt.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import {
  authorizationDecision,
  signedInMomentsAgo,
  signInHeld,
  siteLimiting,
} from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { signIn, type SignInOptions } from "../signIn/engine.ts";
import { authorize } from "./accountUse.ts";
import { signInCodes } from "./signInCodes.ts";

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
    };

/** How one attempt on one row ended. */
export interface SignInAttempt {
  readonly outcome: AccountSignInOutcome;
  readonly message?: string;
  readonly tabId?: PreviewTabId;
  readonly accountId?: AccountId;
}

export type SignInResult =
  | SignInAttempt
  /** `find` matched several saved sign-ins; the caller picks one. */
  | { readonly outcome: "choose"; readonly accounts: ReadonlyArray<AccountSummary> }
  /** `find` matched none. */
  | { readonly outcome: "none" };

interface SignInRequest {
  readonly page?: { readonly tabId?: PreviewTabId | undefined; readonly url?: string };
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
      return account.controls.access !== "off";
  }
});

/**
 * The one way into the sign-in engine: one attempt per real site and identity at a time, across
 * duplicate rows and universities sharing an identity provider. Each attempt reads Accounts afresh
 * inside the lock. A hold is checked first and leaves the record alone: recording a blocked
 * attempt would replace the result that caused it.
 */
const run = Effect.fn("AccountsAgent.guardedSignIn")(function* (request: SignInRequest) {
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

type Run = ReturnType<typeof run>;
/** A named row only ever gives an attempt's outcome; `find` can also give `choose` or `none`. */
export function guardedSignIn(
  request: SignInRequest & { readonly signIn: AccountSummary },
): Effect.Effect<SignInAttempt, Effect.Error<Run>, Effect.Services<Run>>;
export function guardedSignIn(request: SignInRequest): Run;
export function guardedSignIn(request: SignInRequest) {
  return run(request);
}

const attempt = Effect.fn("AccountsAgent.signInAttempt")(function* (
  request: {
    readonly page?: { readonly tabId?: PreviewTabId | undefined };
    readonly caller: SignInCaller;
  },
  accountId: AccountId,
) {
  const { caller } = request;
  const accounts = yield* AccountsService;
  const invocation = yield* AgentInvocationContext;
  const { accounts: rows, agentAccess } = yield* accounts.snapshot;
  const account = rows.find((row) => row.accountId === accountId);
  if (!account)
    return { outcome: "failed", message: "The account no longer exists." } satisfies SignInAttempt;
  const key = attemptKey(account);
  const newest = rows
    .filter((row) => attemptKey(row) === key)
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
  const held = caller.kind !== "check" && signInHeld(newest);
  // A person can still finish a held sign-in by hand; Scient types nothing into it.
  const handOver = held && caller.kind === "agent" && !caller.scope.unattended;
  if (held && !handOver)
    return {
      outcome: "failed",
      message: `${account.name}'s last sign-in didn't go through, so Scient won't repeat it by itself.`,
    } satisfies SignInAttempt;
  const permitted = yield* mayType(caller, account, agentAccess);
  if (!permitted)
    return {
      outcome: "needs-user",
      message: `${account.name}'s access doesn't let Scient type its saved password here.`,
    } satisfies SignInAttempt;
  const session =
    "scope" in caller
      ? caller.scope
      : { threadId: invocation.threadId, projectId: undefined, unattended: true };
  const options: SignInOptions = {
    ...(caller.kind === "agent" ? yield* signInCodes(session, account) : {}),
    ...(automatic(caller) ? { stopAtCode: true } : {}),
    ...(caller.kind === "check" || caller.kind === "paper" ? { userRun: true } : {}),
  };
  const target = { type: "account", accountId: account.accountId } as const;
  const where = {
    threadId: session.threadId,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  };
  return yield* Effect.gen(function* () {
    const values = handOver
      ? {}
      : yield* accounts.resolveSecrets(account.accountId, ["password", "totp"]);
    return yield* signIn(session, account, values, request.page?.tabId, options);
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
        : accounts.recordUse(
            { target, action: "sign-in", ...where, outcome: "error" },
            undefined,
            true,
          ),
    ),
    Effect.map(({ outcome, tabId, ...rest }): SignInAttempt => ({
      outcome,
      tabId,
      accountId: account.accountId,
      ...("message" in rest && rest.message !== undefined ? { message: rest.message } : {}),
    })),
    // A locked store or a full browser says nothing about the sign-in, so no outcome is recorded.
    Effect.catch((error) =>
      Effect.succeed({
        outcome: "failed",
        message: isAccountsError(error)
          ? error.message
          : "The browser sign-in could not be completed.",
      } satisfies SignInAttempt),
    ),
  );
});
