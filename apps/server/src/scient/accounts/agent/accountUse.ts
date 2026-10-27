import { AccountsError, type AccountTarget, type AccountUseAction } from "@t3tools/contracts";
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
      "This account is unavailable to this session. Change its access in Settings → Accounts.",
    );
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
