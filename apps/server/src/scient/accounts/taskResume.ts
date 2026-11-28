/**
 * A pinned scheduled task whose run found its sign-in signed out runs once more as soon as the
 * sign-in is back, whoever signed in (the person on the phone or the computer, or Scient), so the
 * person never has to start it again. Pins whose task is gone are dropped.
 */
import { ScheduledTaskId, type AccountSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../../serverActivation.ts";
import type { TaskPin } from "./AccountPersistence.ts";
import { AccountsService } from "./AccountsService.ts";

/** Waiting pins whose sign-in was seen signed in after the wait began: newer evidence only. */
const resumablePins = (
  pins: ReadonlyArray<TaskPin>,
  accounts: ReadonlyArray<Pick<AccountSummary, "accountId" | "signIn">>,
) =>
  pins.filter((pin) => {
    const signIn = accounts.find((row) => row.accountId === pin.accountId)?.signIn;
    return (
      pin.waiting !== undefined &&
      signIn?.state === "signed-in" &&
      Date.parse(signIn.at) > Date.parse(pin.waiting)
    );
  });

export const taskResumeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* AccountsService;
    const tasks = yield* ScheduledTaskService;
    /** Replays the scheduler refused because the task was running: a run ending wakes only these. */
    const busy = new Set<string>();
    const resume = Effect.fn("TaskResume.resume")(function* (
      rows: ReadonlyArray<AccountSummary>,
      woken: "sign-in" | "scheduler",
    ) {
      const ready = resumablePins(yield* accounts.taskPins, rows).filter(
        (pin) => woken === "sign-in" || busy.has(pin.scheduledTaskId),
      );
      if (ready.length === 0) return;
      const existing = new Set((yield* tasks.list()).tasks.map((task) => task.id as string));
      for (const pin of ready) {
        if (!existing.has(pin.scheduledTaskId)) {
          yield* accounts.updateTaskPin(pin.scheduledTaskId, () => undefined);
          continue;
        }
        // A run the scheduler can't start now keeps the wait: one still running, for its end; any
        // other refusal, for the next sign-in, so a lasting failure never retries in a loop.
        const ran = yield* tasks.runNow({ id: ScheduledTaskId.make(pin.scheduledTaskId) }).pipe(
          Effect.as("ran" as const),
          Effect.catch((error) =>
            Effect.succeed(/already running/iu.test(error.message) ? "busy" : "refused"),
          ),
        );
        if (ran === "busy") busy.add(pin.scheduledTaskId);
        else busy.delete(pin.scheduledTaskId);
        if (ran !== "ran") continue;
        // Only the wait this replay answered: one a newer run began is that run's.
        yield* accounts.updateTaskPin(pin.scheduledTaskId, (current) => {
          if (current === undefined || current.waiting !== pin.waiting) return current;
          const { waiting: _answered, ...rest } = current;
          return rest;
        });
      }
    });
    // A sign-in seen, or a scheduler change such as a run ending, which frees a replay it refused.
    const wakes = Stream.merge(
      accounts.changes.pipe(Stream.map((snapshot) => [snapshot.accounts, "sign-in"] as const)),
      tasks.subscribeList().pipe(
        // A run ending may come with nobody there: a store whose key would ask stays closed.
        Stream.filterEffect(() =>
          accounts.openWithoutPrompt.pipe(Effect.orElseSucceed(() => false)),
        ),
        Stream.mapEffect(() =>
          accounts.snapshot.pipe(
            Effect.map((snapshot) => [snapshot.accounts, "scheduler"] as const),
            Effect.orElseSucceed(() => [[], "scheduler"] as const),
          ),
        ),
        Stream.catch(() => Stream.empty),
      ),
    );
    yield* forkParked(
      wakes.pipe(Stream.runForEach(([rows, woken]) => resume(rows, woken).pipe(Effect.ignore))),
    );
  }),
);
