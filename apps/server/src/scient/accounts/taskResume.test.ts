import { describe, expect, it } from "@effect/vitest";
import { ScheduledTaskError, type AccountsSnapshot, type ScheduledTask } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import type { TaskPin } from "./AccountPersistence.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { taskResumeLayer } from "./taskResume.ts";

const WAITED = "2026-11-26T11:00:00.000Z";
const pin = (scheduledTaskId: string, waiting = true): TaskPin => ({
  scheduledTaskId,
  accountId: "acc_hours0001" as TaskPin["accountId"],
  profileId: "work" as TaskPin["profileId"],
  environmentId: "env-here",
  username: "dana@example.test",
  ...(waiting ? { waiting: WAITED } : {}),
});

/** One change in Accounts, the row seen signed in at `at`; the scheduler may refuse to run. */
const resumeOnce = Effect.fn("resumeOnce")(function* (
  pins: Map<string, TaskPin>,
  at: string,
  scheduler: { readonly busy: boolean },
) {
  const ran: string[] = [];
  const settled = yield* Deferred.make<void>();
  const accounts = AccountsService.of({
    ...fakeAccounts({}).service,
    changes: Stream.make({
      accounts: [{ accountId: "acc_hours0001", signIn: { state: "signed-in", at } }],
    } as unknown as AccountsSnapshot),
    taskPins: Effect.sync(() => [...pins.values()]),
    updateTaskPin: (id, update) =>
      Effect.sync(() => {
        const next = update(pins.get(id));
        if (next === undefined) pins.delete(id);
        else pins.set(id, next);
      }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
  });
  const tasks = Layer.mock(ScheduledTaskService)({
    subscribeList: () => Stream.empty,
    list: () =>
      Effect.succeed({
        tasks: [{ id: "task:hours" }] as unknown as Array<ScheduledTask>,
      }),
    // A refused run is the turn's last step; an accepted one is followed by its settlement.
    runNow: (input) =>
      Effect.suspend(() => {
        ran.push(input.id);
        return scheduler.busy
          ? Effect.fail(new ScheduledTaskError({ message: "This task is already running." }))
          : Effect.succeed({ threadId: null } as never);
      }).pipe(Effect.ensuring(scheduler.busy ? Deferred.succeed(settled, undefined) : Effect.void)),
  });
  yield* Effect.gen(function* () {
    yield* Layer.build(taskResumeLayer);
    yield* Deferred.await(settled);
  }).pipe(Effect.provideService(AccountsService, accounts), Effect.provide(tasks), Effect.scoped);
  return ran;
});

describe("taskResumeLayer", () => {
  it.effect("runs a waiting task once on a newer sign-in, and settles only that wait", () =>
    Effect.gen(function* () {
      const pins = new Map([["task:hours", pin("task:hours")]]);
      expect(yield* resumeOnce(pins, "2026-11-26T12:00:00.000Z", { busy: false })).toEqual([
        "task:hours",
      ]);
      expect(pins.get("task:hours")?.waiting).toBeUndefined();
    }),
  );

  it.effect("keeps the wait when the scheduler can't run it yet", () =>
    Effect.gen(function* () {
      const pins = new Map([["task:hours", pin("task:hours")]]);
      // regression: the wait was cleared before a run the scheduler refused, losing the replay.
      expect(yield* resumeOnce(pins, "2026-11-26T12:00:00.000Z", { busy: true })).toEqual([
        "task:hours",
      ]);
      expect(pins.get("task:hours")?.waiting).toBe(WAITED);
    }),
  );

  it.effect("tries a refused replay again when the scheduler's run ends", () =>
    Effect.gen(function* () {
      const pins = new Map([["task:hours", pin("task:hours")]]);
      const ran: string[] = [];
      let busy = true;
      const refused = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const ended = yield* Queue.unbounded<void>();
      const accounts = AccountsService.of({
        ...fakeAccounts({}).service,
        changes: Stream.make({
          accounts: [
            {
              accountId: "acc_hours0001",
              signIn: { state: "signed-in", at: "2026-11-26T12:00:00.000Z" },
            },
          ],
        } as unknown as AccountsSnapshot),
        snapshot: Effect.succeed({
          accounts: [
            {
              accountId: "acc_hours0001",
              signIn: { state: "signed-in", at: "2026-11-26T12:00:00.000Z" },
            },
          ],
        } as never),
        taskPins: Effect.sync(() => [...pins.values()]),
        updateTaskPin: (id, update) =>
          Effect.sync(() => {
            const next = update(pins.get(id));
            if (next === undefined) pins.delete(id);
            else pins.set(id, next);
          }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
      });
      const tasks = Layer.mock(ScheduledTaskService)({
        subscribeList: () => Stream.fromQueue(ended).pipe(Stream.as({ tasks: [] } as never)),
        list: () =>
          Effect.succeed({ tasks: [{ id: "task:hours" }] as unknown as Array<ScheduledTask> }),
        runNow: (input) =>
          Effect.suspend(() => {
            ran.push(input.id);
            if (!busy) return Effect.succeed({ threadId: null } as never);
            busy = false;
            return Deferred.succeed(refused, undefined).pipe(
              Effect.andThen(Effect.fail(new ScheduledTaskError({ message: "Already running." }))),
            );
          }),
      });
      yield* Effect.gen(function* () {
        yield* Layer.build(taskResumeLayer);
        yield* Deferred.await(refused);
        // regression: a replay refused while the task ran waited for the next sign-in, forever.
        yield* Queue.offer(ended, undefined);
        yield* Deferred.await(settled);
      }).pipe(
        Effect.provideService(AccountsService, accounts),
        Effect.provide(tasks),
        Effect.scoped,
      );
      expect(ran).toEqual(["task:hours", "task:hours"]);
      expect(pins.get("task:hours")?.waiting).toBeUndefined();
    }),
  );

  it.effect(
    "never retries a replay the scheduler refused for another reason on its own changes",
    () =>
      Effect.gen(function* () {
        const pins = new Map([["task:hours", pin("task:hours")]]);
        const ran: string[] = [];
        const refused = yield* Deferred.make<void>();
        const looked = yield* Deferred.make<void>();
        const changed = yield* Queue.unbounded<void>();
        const row = {
          accountId: "acc_hours0001",
          signIn: { state: "signed-in", at: "2026-11-26T12:00:00.000Z" },
        };
        let snapshots = 0;
        const accounts = AccountsService.of({
          ...fakeAccounts({}).service,
          changes: Stream.make({ accounts: [row] } as unknown as AccountsSnapshot),
          // Read once per scheduler change: the second read is the second change, handled.
          snapshot: Effect.suspend(() =>
            ++snapshots === 2 ? Deferred.succeed(looked, undefined) : Effect.void,
          ).pipe(Effect.as({ accounts: [row] } as never)),
          taskPins: Effect.sync(() => [...pins.values()]),
        });
        const tasks = Layer.mock(ScheduledTaskService)({
          subscribeList: () => Stream.fromQueue(changed).pipe(Stream.as({ tasks: [] } as never)),
          list: () =>
            Effect.succeed({ tasks: [{ id: "task:hours" }] as unknown as Array<ScheduledTask> }),
          // The run is reserved, then its record can't be written: a list change, every time.
          runNow: (input) =>
            Effect.suspend(() => {
              ran.push(input.id);
              return Deferred.succeed(refused, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ScheduledTaskError({ message: "Could not record schedule task run." }),
                  ),
                ),
              );
            }),
        });
        yield* Effect.gen(function* () {
          yield* Layer.build(taskResumeLayer);
          yield* Deferred.await(refused);
          yield* Queue.offer(changed, undefined);
          yield* Queue.offer(changed, undefined);
          yield* Deferred.await(looked);
        }).pipe(
          Effect.provideService(AccountsService, accounts),
          Effect.provide(tasks),
          Effect.scoped,
        );
        // regression: each list change the failed run made replayed it again.
        expect(ran).toEqual(["task:hours"]);
        expect(pins.get("task:hours")?.waiting).toBe(WAITED);
      }),
  );

  it.effect("reads nothing from Accounts on a scheduler change while its store would ask", () =>
    Effect.gen(function* () {
      let open = false;
      /** Each ask, and whether the store could open without the person then. */
      const asks: boolean[] = [];
      const read = yield* Deferred.make<ReadonlyArray<boolean>>();
      const accounts = AccountsService.of({
        ...fakeAccounts({}).service,
        changes: Stream.never,
        openWithoutPrompt: Effect.sync(() => {
          asks.push(open);
          const was = open;
          // The person opens Accounts before the next change.
          open = true;
          return was;
        }),
        snapshot: Effect.suspend(() => Deferred.succeed(read, [...asks])).pipe(
          Effect.as({ accounts: [] } as never),
        ),
      });
      const tasks = Layer.mock(ScheduledTaskService)({
        // Two runs end: one before the person opens Accounts, one after.
        subscribeList: () => Stream.make([], []) as never,
        list: () => Effect.succeed({ tasks: [] }),
      });
      yield* Effect.gen(function* () {
        yield* Layer.build(taskResumeLayer);
        // regression: the first change read Accounts, asking for the keychain with nobody there.
        expect(yield* Deferred.await(read)).toEqual([false, true]);
      }).pipe(
        Effect.provideService(AccountsService, accounts),
        Effect.provide(tasks),
        Effect.scoped,
      );
    }),
  );
});
