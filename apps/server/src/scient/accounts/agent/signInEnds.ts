import type { AccountId, AccountsError, AccountSignInEnd } from "@t3tools/contracts";
import { accountHandoffInstruction } from "@t3tools/shared/scientSignInPage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AccountsService } from "../AccountsService.ts";
import type { SignInAttempt } from "./guardedSignIn.ts";

const MESSAGE_LENGTH = 500;

/** How the person reads an attempt's end. Waiting at a code still needs them. */
function signInEndOf(attempt: SignInAttempt): AccountSignInEnd["outcome"] {
  if (attempt.outcome === "signed-in") return "signed-in";
  if (attempt.ended) return attempt.ended;
  return attempt.outcome === "needs-user" || attempt.pending ? "needs-you" : "failed";
}

/** Keeps how the person's sign-in to a row ended, failures before its tab opened included. */
export const recordSignInEnd = Effect.fn("AccountsAgent.recordSignInEnd")(function* (
  accountId: AccountId,
  exit: Exit.Exit<SignInAttempt, AccountsError>,
) {
  const message = Exit.isSuccess(exit)
    ? exit.value.message
    : "The browser could not open the sign-in.";
  const end = {
    accountId,
    outcome: Exit.isSuccess(exit) ? signInEndOf(exit.value) : "failed",
    ...(message ? { message: message.slice(0, MESSAGE_LENGTH) } : {}),
    at: DateTime.formatIso(yield* DateTime.now),
  } satisfies AccountSignInEnd;
  yield* (yield* AccountsService).setSignInEnd(end);
  yield* settleNeedsYou(end, Exit.isSuccess(exit) ? exit.value.factor : undefined);
});

/**
 * A sign-in left needing the person, or out of their time, is one entry in Accounts' Needs you,
 * the same one an unattended sign-in leaves, naming the step it waits at; signing in or
 * cancelling clears it.
 */
const settleNeedsYou = Effect.fn("AccountsAgent.settleNeedsYou")(function* (
  end: AccountSignInEnd,
  factor: SignInAttempt["factor"],
) {
  const accounts = yield* AccountsService;
  const needId = `sign-in:${end.accountId}`;
  if (end.outcome === "signed-in" || end.outcome === "cancelled")
    return yield* accounts.clearNeedsYou(needId);
  if (end.outcome === "failed") return;
  const account = (yield* accounts.snapshot).accounts.find(
    (row) => row.accountId === end.accountId,
  );
  if (account)
    yield* accounts.setNeedsYou({
      needId,
      name: account.name,
      detail: factor ? accountHandoffInstruction(factor) : "Waiting for you to sign in",
      action: "sign-in",
      accountId: account.accountId,
    });
}, Effect.ignore);
