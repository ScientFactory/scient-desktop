/**
 * Scheduled tasks pinned to one sign-in, in its profile, on this computer. Before each run Scient
 * checks it is still that sign-in and that it works there, so a run never goes out as someone
 * else, from another profile or another computer. A signed-out run raises one Needs you and waits;
 * nothing retries it in a loop.
 */
import {
  type AccountNeedsYou,
  type AccountSignInState,
  type AccountSummary,
  type ProjectId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { loginUserKey } from "@t3tools/shared/scientLoginIdentity";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { agentAccessOff, inScope, signedOutOnPurpose } from "./AccountDecisions.ts";
import type { TaskPin } from "./AccountPersistence.ts";
import { AccountsService } from "./AccountsService.ts";
import { awaitsPerson } from "./awaitPerson.ts";
import { lookBeforeRun } from "./checkAccounts.ts";
import { pinBinds, profileOf, UNREADABLE_PIN, usernameOf } from "./taskPinRules.ts";

/** Worked; signed out; signed in but not allowed (or not the same sign-in); couldn't reach. */
export type PinClass = NonNullable<TaskPin["last"]>;

/** A look this recent that found the row signed in stands for the run; no extra visit. */
const SEEN_FRESH_MS = 30 * 60 * 1000;

/**
 * The pin for a row as it is now, on this computer, made from `projectId`. Undefined for a row
 * with no username yet: its identity couldn't be checked at each run.
 */
export const pinFor = (
  scheduledTaskId: string,
  account: AccountSummary,
  environmentId: string,
  projectId: ProjectId | undefined,
): TaskPin | undefined => {
  const username = usernameOf(account);
  return username === undefined || username === ""
    ? undefined
    : {
        scheduledTaskId,
        accountId: account.accountId,
        profileId: profileOf(account),
        environmentId,
        username,
        ...(projectId === undefined ? {} : { projectId }),
      };
};

export type PinVerdict =
  | { readonly class: Exclude<PinClass, "worked">; readonly reason: string }
  | { readonly class: "worked" }
  | { readonly class: "look"; readonly account: AccountSummary };

/** What can be told before any visit; `look` means only the site can say. */
export function pinVerdict(input: {
  readonly pin: TaskPin;
  readonly account: AccountSummary | undefined;
  readonly environmentId: string;
  readonly projectId: ProjectId;
  readonly agentAccess: boolean;
  readonly needsYou: ReadonlyArray<AccountNeedsYou>;
  readonly now: number;
}): PinVerdict {
  const { pin, account } = input;
  const notAllowed = (reason: string) => ({ class: "not-allowed" as const, reason });
  if (pin.environmentId !== input.environmentId)
    return notAllowed("It is pinned to a sign-in on another computer.");
  if (account === undefined || account.details.kind !== "website")
    return notAllowed("Its sign-in was removed.");
  if (profileOf(account) !== pin.profileId)
    return notAllowed(`${account.name} moved to another browser profile.`);
  if (loginUserKey(pin.username) !== loginUserKey(usernameOf(account)))
    return notAllowed(`${account.name} now signs in as someone else.`);
  if (agentAccessOff(input.agentAccess, account.controls.access))
    return notAllowed(`${account.name} is off for agents.`);
  if (!inScope(account.controls.scope, input.projectId))
    return notAllowed(`${account.name} isn't available in this task's project.`);
  const signedOut = { class: "signed-out" as const, reason: `${account.name} is signed out.` };
  if (input.needsYou.some((need) => need.needId === `sign-in:${account.accountId}`))
    return signedOut;
  if (signedOutOnPurpose(account.signIn)) return signedOut;
  const { signIn } = account;
  if (signIn?.state === "signed-in" && input.now - Date.parse(signIn.at) < SEEN_FRESH_MS)
    return { class: "worked" };
  return { class: "look", account };
}

/**
 * What the look found, as the run's class: confirmed expiry, access refused (the site limiting
 * it), or nothing reached. A look that couldn't tell, or a sign-in that failed for another reason,
 * is not an expiry: the run goes ahead, or waits as unreachable.
 */
export const lookClass = (state: AccountSignInState, unreachable: boolean): PinClass => {
  switch (state) {
    case "signed-in":
      return "worked";
    case "signed-out":
    case "needs-you":
    case "password-rejected":
    case "code-rejected":
      return "signed-out";
    case "limited":
      return "not-allowed";
    case "failed":
      return "unreachable";
    case "unknown":
      return unreachable ? "unreachable" : "worked";
  }
};

/** The same sign-in pinned the same way, whatever the pin last recorded about its runs. */
const samePin = (a: TaskPin, b: TaskPin) =>
  a.accountId === b.accountId &&
  a.profileId === b.profileId &&
  a.environmentId === b.environmentId &&
  a.username === b.username &&
  a.projectId === b.projectId;

/** A run, or a trigger change, that would open Accounts while nobody can answer its dialog. */
export const AWAITS_PERSON: unique symbol = Symbol("AWAITS_PERSON");

/** The scheduler asks this before each run; a reason means the run doesn't go ahead. */
export class ScheduledRunGate extends Context.Service<
  ScheduledRunGate,
  {
    readonly beforeRun: (
      task: Pick<ScheduledTask, "id" | "projectId" | "threadId">,
    ) => Effect.Effect<string | typeof AWAITS_PERSON | undefined>;
    /** Whether the task has a pin, readable or not: a pinned task never becomes webhook-run. */
    readonly pinned?: (taskId: string) => Effect.Effect<boolean | typeof AWAITS_PERSON>;
    /** Runs a trigger edit as the task's only pin or trigger edit (`withTaskEdit`). */
    readonly withTaskEdit?: <A, E, R>(
      taskId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/scient/accounts/taskPins/ScheduledRunGate") {}

/** Why a pinned task can't be made webhook-run: a delivery it blocked could never be replayed. */
export const PINNED_WEBHOOK =
  "This task uses a pinned sign-in, and a webhook task can't. Unpin it first.";

export const scheduledRunGateLayer = Layer.effect(
  ScheduledRunGate,
  Effect.gen(function* () {
    const accounts = yield* AccountsService;
    const environment = yield* ServerEnvironment;
    const broker = yield* PreviewAutomationBroker;
    const decide = Effect.fn("ScheduledRunGate.decide")(function* (
      task: Pick<ScheduledTask, "id" | "projectId" | "threadId">,
      pin: TaskPin,
    ) {
      const environmentId = yield* environment.getEnvironmentId;
      const snapshot = yield* accounts.snapshot;
      const verdict = pinVerdict({
        pin,
        account: snapshot.accounts.find((row) => row.accountId === pin.accountId),
        environmentId,
        projectId: task.projectId,
        agentAccess: snapshot.agentAccess,
        needsYou: snapshot.needsYou ?? [],
        now: yield* Clock.currentTimeMillis,
      });
      if (verdict.class !== "look") return verdict;
      const look = yield* lookBeforeRun(verdict.account, environmentId, task.id).pipe(
        Effect.provideService(AccountsService, accounts),
        Effect.provideService(PreviewAutomationBroker, broker),
      );
      const found = lookClass(look.state, look.unreachable);
      const name = verdict.account.name;
      return found === "worked"
        ? { class: "worked" as const }
        : {
            class: found,
            reason:
              found === "unreachable"
                ? `Scient couldn't reach ${name} from this computer. The sign-in is not affected.`
                : found === "not-allowed"
                  ? `${name} is limiting access from this network.`
                  : `${name} is signed out.`,
          };
    });
    const beforeRun = Effect.fn("ScheduledRunGate.check")(function* (
      task: Pick<ScheduledTask, "id" | "projectId" | "threadId">,
    ) {
      // Both kinds in one read, after the saved state loaded: a cold start knows its pins.
      const pin = yield* accounts
        .taskPinOf(task.id)
        .pipe(Effect.catchIf(awaitsPerson, () => Effect.succeed(AWAITS_PERSON)));
      if (pin === AWAITS_PERSON) return AWAITS_PERSON;
      if (pin === "unreadable") return UNREADABLE_PIN;
      if (pin === undefined || !pinBinds(pin, task.projectId)) return undefined;
      const verdict = yield* decide(task, pin);
      const waiting = verdict.class === "signed-out";
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      // Signed out, it waits from the first such run; any other run settles the wait.
      // Only onto the pin this verdict was about: a repin meanwhile keeps its own.
      yield* accounts.updateTaskPin(task.id, (current) => {
        if (current === undefined || !samePin(current, pin)) return current;
        const { waiting: since, ...rest } = current;
        return { ...rest, last: verdict.class, ...(waiting ? { waiting: since ?? at } : {}) };
      });
      if (waiting)
        yield* accounts.setNeedsYou({
          needId: `sign-in:${pin.accountId}`,
          name:
            (yield* accounts.snapshot).accounts.find((row) => row.accountId === pin.accountId)
              ?.name ?? "Sign-in",
          detail: "Waiting for you to sign in",
          action: "sign-in",
          accountId: pin.accountId,
          ...(task.threadId === null ? {} : { threadId: task.threadId }),
        });
      return verdict.class === "worked" ? undefined : verdict.reason;
    });
    // Accounts trouble never stops a task by itself: the run goes ahead and says what it finds.
    return ScheduledRunGate.of({
      beforeRun: Effect.fn("ScheduledRunGate.beforeRun")((task) =>
        beforeRun(task).pipe(Effect.orElseSucceed(() => undefined)),
      ),
      withTaskEdit: accounts.withTaskEdit,
      // Unreadable Accounts counts as pinned: the change can wait, a lost replay can't.
      pinned: Effect.fn("ScheduledRunGate.pinned")((taskId) =>
        accounts.taskPinOf(taskId).pipe(
          Effect.map((pin): boolean | typeof AWAITS_PERSON => pin !== undefined),
          Effect.catchIf(awaitsPerson, () => Effect.succeed(AWAITS_PERSON)),
          Effect.orElseSucceed(() => true),
        ),
      ),
    });
  }),
);
