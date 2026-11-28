import { type AccountTarget, type AccountUseAction, type AccountSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AccountsService, fail, type AccountSessionScope } from "../AccountsService.ts";
import { needIdOf, needsYou, personTimeLeft } from "./cardAllowance.ts";

export const authorize = Effect.fn("AccountsAgent.authorize")(function* (
  scope: AccountSessionScope,
  target: AccountTarget,
  action: AccountUseAction,
) {
  const accounts = yield* AccountsService;
  const decision = yield* accounts.authorize(scope, target, action, {
    waitMs: yield* personTimeLeft,
  });
  if (decision.decision === "denied") {
    // Nobody answered: it waits on its row for the person, once.
    if (
      decision.reason === "timed-out" ||
      (scope.unattended && decision.reason !== "out-of-scope" && decision.reason !== "pinned")
    )
      yield* needsYou(target, scope, action);
    return yield* fail(
      "denied",
      decision.reason === "pinned"
        ? "This scheduled task runs only as its pinned sign-in, in its pinned profile."
        : decision.reason === "out-of-scope"
          ? "This account isn't available in this project."
          : decision.reason === "timed-out" || scope.unattended
            ? "The user wasn't there to allow it. It waits for them on the account; carry on without it."
            : "The user didn't allow this account here. Don't ask again this turn.",
    );
  }
  // Allowed now: an entry an earlier unanswered card left is settled.
  if (action !== "sign-in")
    yield* accounts.clearNeedsYou(needIdOf(target, action)).pipe(Effect.ignore);
});
export const withAccountUse = Effect.fn("AccountsAgent.use")(function* <A, E, R>(
  scope: AccountSessionScope,
  target: AccountTarget,
  action: AccountUseAction,
  operation: Effect.Effect<A, E, R>,
  succeeded: (result: A) => boolean = () => true,
) {
  const accounts = yield* AccountsService;
  yield* authorize(scope, target, action);
  return yield* operation.pipe(
    Effect.onExit((exit) =>
      accounts.recordUse({
        target,
        action,
        threadId: scope.threadId,
        ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
        outcome: exit._tag === "Success" && succeeded(exit.value) ? "ok" : "error",
      }),
    ),
  );
});

/** The tools an agent can use this account with. */
export const accountUsage = (account: AccountSummary) =>
  account.controls.access === "off"
    ? []
    : [
        ...(account.controls.visibility === "readable" ? ["scient_account_credentials"] : []),
        ...(account.details.kind === "api-key" && account.details.sites.length > 0
          ? ["scient_account_request"]
          : []),
        ...(account.details.kind === "website"
          ? ["scient_account_sign_in", "scient_account_fill", "scient_account_browser_session"]
          : []),
      ];
