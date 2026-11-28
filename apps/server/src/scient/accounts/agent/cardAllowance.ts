import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { AccountTarget, AccountUseAction, ProviderInstanceId } from "@t3tools/contracts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { personWaitMs } from "../../../provider/ScientPersonWaitTools.ts";

/** The calling agent's driver, when the registry knows its instance. */
const callerDriver = Effect.fn("AccountsAgent.callerDriver")(function* (
  instanceId: ProviderInstanceId | undefined,
) {
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  if (instanceId === undefined || Option.isNone(registry)) return undefined;
  const providers = yield* registry.value.getProviders;
  return providers.find((provider) => provider.instanceId === instanceId)?.driver;
});

/** Kept between a card's close and the call's deadline, for the answer to reach the caller. */
export const CARD_RETURN_MS = 5_000;
/** A card with less time left than this could not be answered, so it is not opened. */
export const MIN_CARD_MS = 15_000;

/**
 * The time one tool call has for the person, shared by every card it opens: set when the call
 * starts, it ends for good once a card times out or the run ends under one.
 */
interface CardAllowance {
  readonly deadline: number;
  readonly ended: Ref.Ref<"cancelled" | "timed_out" | undefined>;
}

export const CurrentCardAllowance = Context.Reference<CardAllowance | undefined>(
  "scient/accounts/CardAllowance",
  { defaultValue: () => undefined },
);

export const startAllowance = Effect.gen(function* () {
  const invocation = yield* Effect.serviceOption(McpInvocationContext);
  const driver = yield* callerDriver(Option.getOrUndefined(invocation)?.thread?.providerInstanceId);
  return {
    // Less than the calling agent keeps one silent tool call open.
    deadline: (yield* Clock.currentTimeMillis) + personWaitMs(driver),
    ended: yield* Ref.make<"cancelled" | "timed_out" | undefined>(undefined),
  } satisfies CardAllowance;
});

/**
 * Runs a tool call that may open cards under one allowance from its start, so its cards together
 * end before the caller would drop the call. A call inside another keeps the outer allowance.
 */
export const withCardAllowance = Effect.fn("AccountsAgent.withCardAllowance")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  if ((yield* CurrentCardAllowance) !== undefined) return yield* effect;
  return yield* effect.pipe(Effect.provideService(CurrentCardAllowance, yield* startAllowance));
});

/** What is left of this call's time for the person, less the time its answer needs to return. */
export const personTimeLeft = Effect.gen(function* () {
  const allowance = (yield* CurrentCardAllowance) ?? (yield* startAllowance);
  return allowance.deadline - (yield* Clock.currentTimeMillis) - CARD_RETURN_MS;
});

/** The Needs-you entry for an item an agent waits on: one per item, a sign-in's shared with Scient's. */
export const needIdOf = (target: AccountTarget, action: AccountUseAction) =>
  target.type === "account"
    ? `${action === "sign-in" ? "sign-in" : "allow"}:${target.accountId}`
    : `allow:profile:${target.profileId}`;

/**
 * One "Needs you" for an item an agent couldn't use because nobody answered, instead of a longer
 * wait; its Activity line says so too. Using the item clears it.
 */
export const needsYou = Effect.fn("AccountsAgent.needsYou")(function* (
  target: AccountTarget,
  scope: AccountSessionScope,
  action: AccountUseAction,
) {
  const accounts = yield* AccountsService;
  yield* accounts.recordUse({
    target,
    action,
    threadId: scope.threadId,
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    outcome: "error",
  });
  const snapshot = yield* accounts.snapshot.pipe(Effect.orElseSucceed(() => undefined));
  if (snapshot === undefined) return;
  const name =
    target.type === "account"
      ? snapshot.accounts.find((account) => account.accountId === target.accountId)?.name
      : (snapshot.profiles.find((profile) => profile.profileId === target.profileId)?.source
          ?.profileName ?? "Browser profile");
  if (name === undefined) return;
  yield* accounts
    .setNeedsYou({
      needId: needIdOf(target, action),
      name,
      detail: action === "sign-in" ? "Waiting for you to sign in" : "Waiting for you to allow it",
      action: action === "sign-in" ? "sign-in" : "allow",
      ...(target.type === "account" ? { accountId: target.accountId } : {}),
      threadId: scope.threadId,
    })
    .pipe(Effect.ignore);
});
