import { AccountsError, type AccountSummary, type PreviewTabId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  agentSignInOnHold,
  automaticSignInOnHold,
  signedInMomentsAgo,
  siteLimiting,
} from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { signIn, type SignInOptions } from "../signIn/engine.ts";
import { authorize } from "./accountUse.ts";

const isAccountsError = Schema.is(AccountsError);

/**
 * The one way into the sign-in engine. A hold is checked first and leaves the account's record
 * alone, because recording a blocked attempt would replace the result that caused the hold.
 */
export const guardedSignIn = Effect.fn("AccountsAgent.guardedSignIn")(function* (
  scope: AccountSessionScope,
  account: AccountSummary,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    /** Nobody asked for this sign-in by name: Scient decided to try. */
    readonly automatic?: boolean;
    /** The caller already authorized this use. */
    readonly authorized?: boolean;
    readonly engine?: SignInOptions;
  } = {},
) {
  const accounts = yield* AccountsService;
  const now = yield* Clock.currentTimeMillis;
  if (siteLimiting(account, now))
    return {
      outcome: "limited" as const,
      message: "The site is limiting access from this network. Try again in an hour.",
    };
  if (input.automatic && signedInMomentsAgo(account, now))
    return {
      outcome: "failed" as const,
      message: `${account.name} signed in moments ago, so something keeps ending it. Scient won't repeat it by itself; tell the user.`,
    };
  if (
    input.automatic ? automaticSignInOnHold(account, now) : agentSignInOnHold(account, scope, now)
  )
    return {
      outcome: "failed" as const,
      message: `${account.name}'s last sign-in didn't go through (${account.lastCheck?.message ?? account.lastSignInOutcome ?? "see Accounts"}), so Scient won't repeat it. Tell the user.`,
    };
  const target = { type: "account", accountId: account.accountId } as const;
  if (!input.authorized) yield* authorize(scope, target, "sign-in");
  const result = yield* Effect.gen(function* () {
    const values = yield* accounts.resolveSecrets(account.accountId, ["password", "totp"]);
    return yield* signIn(scope, account, values, input.tabId, input.engine);
  }).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Success"
        ? accounts.recordUse(
            {
              target,
              action: "sign-in",
              threadId: scope.threadId,
              ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
              signInOutcome: exit.value.outcome,
              outcome: exit.value.outcome === "signed-in" ? "ok" : "error",
            },
            "message" in exit.value ? exit.value.message : undefined,
          )
        : accounts.recordUse({
            target,
            action: "sign-in",
            threadId: scope.threadId,
            ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
            outcome: "error",
          }),
    ),
    // A locked store or a full browser says nothing about the sign-in, so no outcome is recorded.
    Effect.catch((error) =>
      Effect.succeed({
        outcome: "failed" as const,
        message: isAccountsError(error)
          ? error.message
          : "The browser sign-in could not be completed.",
      }),
    ),
  );
  return result;
});
