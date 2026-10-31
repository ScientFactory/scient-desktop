import {
  AccountsError,
  type AccountTarget,
  type AccountUseAction,
  type AccountActivityEntry,
  type AccountSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";

const fail = (reason: AccountsError["reason"], message: string) =>
  new AccountsError({ reason, message });
export const authorize = Effect.fn("AccountsAgent.authorize")(function* (
  scope: AccountSessionScope,
  target: AccountTarget,
  action: AccountUseAction,
) {
  const accounts = yield* AccountsService;
  const decision = yield* accounts.authorize(scope, target, action);
  if (decision.decision === "denied")
    return yield* fail(
      "denied",
      "This account is unavailable to this session. Change its access in Settings → Accounts & secrets.",
    );
});
export const withAccountUse = Effect.fn("AccountsAgent.use")(function* <A, E, R>(
  scope: AccountSessionScope,
  target: AccountTarget,
  action: AccountUseAction,
  operation: Effect.Effect<A, E, R>,
  succeeded: (result: A) => boolean = () => true,
  signInOutcome?: (result: A) => AccountActivityEntry["signInOutcome"],
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
        ...(exit._tag === "Success" && signInOutcome
          ? { signInOutcome: signInOutcome(exit.value) }
          : {}),
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
        ...(["website", "library"].includes(account.details.kind)
          ? ["scient_account_sign_in", "scient_account_fill", "scient_account_browser_session"]
          : []),
      ];
