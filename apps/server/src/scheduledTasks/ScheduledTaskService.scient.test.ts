import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import type { AccountKeychain } from "../scient/accounts/AccountVault.ts";
import { ACCOUNTS_AWAIT_PERSON } from "../scient/accounts/awaitPerson.ts";
import {
  makeHarness,
  memoryStore,
  noKeychain,
  recordingKeychain,
  windowLeases,
  website,
} from "../scient/accounts/Accounts.testkit.ts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
import {
  PINNED_WEBHOOK,
  ScheduledRunGate,
  scheduledRunGateLayer,
} from "../scient/accounts/taskPins.ts";
import { UNREADABLE_PIN } from "../scient/accounts/taskPinRules.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project:test");

const scheduler = (gate: Layer.Layer<ScheduledRunGate>, sent: Ref.Ref<number>) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
          getThreadShell: () =>
            Effect.succeed({ projectId, archivedAt: null, deletedAt: null } as never),
          // A scheduled occurrence first looks for an earlier one still queued.
          getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        gate,
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );

const hourly = {
  id: ScheduledTaskId.make("task:hours"),
  title: "Hours",
  prompt: "Read this week's hours",
  enabled: true,
  schedule: { type: "interval" as const, everyMs: 60 * 60_000 },
  projectId,
  threadId: ThreadId.make("thread:hours"),
  workspaceStrategy: { type: "root" as const },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

it.effect("a run its pinned sign-in blocks sends nothing and keeps the task's schedule", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const sent = yield* Ref.make(0);
    const gate = Layer.succeed(ScheduledRunGate, {
      beforeRun: () => Effect.succeed("Course portal is signed out."),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(hourly);
      yield* service.runNow({ id: task.id });
      const after = (yield* service.list()).tasks.find((candidate) => candidate.id === task.id);
      assert.equal(yield* Ref.get(sent), 0);
      assert.equal(after?.lastRunStatus, "failed");
      assert.equal(after?.lastRunError, "Course portal is signed out.");
      // The next occurrence stays at its time: a blocked run is never retried in a loop.
      assert.isNotNull(after?.nextRunAt ?? null);
      assert.isTrue(Date.parse(after!.nextRunAt!) > Date.parse("2026-11-01T07:00:00.000Z"));
    }).pipe(Effect.provide(scheduler(gate, sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const realGate = (accounts: AccountsService["Service"]) =>
  scheduledRunGateLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AccountsService, accounts),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-here")),
        } as unknown as ServerEnvironment["Service"]),
        Layer.succeed(PreviewAutomationBroker, {} as PreviewAutomationBroker["Service"]),
      ),
    ),
  );

/** Saves an allowed sign-in and pins `taskId` to it, the person there, in a store that then closes. */
const savedPin = (
  storage: ReturnType<typeof memoryStore>,
  keychain: AccountKeychain,
  taskId: ScheduledTaskId,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { leases } = yield* windowLeases(true);
      const { service } = yield* makeHarness({ storage, keychain, leases });
      const { accountId } = yield* service.save(website());
      // Signed in just now: the run's look is fresh.
      yield* service.recordCheck(accountId, { state: "signed-in" });
      yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      yield* service.updateTaskPin(taskId, () => ({
        scheduledTaskId: taskId,
        accountId,
        profileId: BrowserProfileId.make("default"),
        environmentId: "env-here",
        username: "synthetic-user",
        projectId,
      }));
      return accountId;
    }),
  );

it.effect("a run that goes through settles the wait an earlier signed-out run left", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const sent = yield* Ref.make(0);
    const { service: accounts } = yield* makeHarness();
    const { accountId } = yield* accounts.save(website());
    yield* accounts.setControls({ target: { type: "account", accountId }, access: "allowed" });
    yield* accounts.recordCheck(accountId, { state: "signed-in" });
    yield* accounts.updateTaskPin(hourly.id, () => ({
      scheduledTaskId: hourly.id,
      accountId,
      profileId: BrowserProfileId.make("default"),
      environmentId: "env-here",
      username: "synthetic-user",
      projectId,
      waiting: "2026-11-01T06:00:00.000Z",
    }));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(hourly);
      yield* service.runNow({ id: hourly.id });
      assert.equal(yield* Ref.get(sent), 1);
      // regression: the wait stayed, so the next sign-in ran the task a second time.
      assert.isUndefined((yield* accounts.taskPins)[0]?.waiting);
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("the real gate refuses a run whose pinned sign-in was removed", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const sent = yield* Ref.make(0);
    const { service: accounts } = yield* makeHarness();
    const { accountId } = yield* accounts.save(website());
    yield* accounts.updateTaskPin(hourly.id, () => ({
      scheduledTaskId: hourly.id,
      accountId,
      profileId: BrowserProfileId.make("default"),
      environmentId: "env-here",
      username: "synthetic-user",
      projectId,
    }));
    // regression: removing the row hid its pin, so the task ran unpinned.
    yield* accounts.remove(accountId);
    const gate = realGate(accounts);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(hourly);
      yield* service.runNow({ id: task.id });
      const after = (yield* service.list()).tasks.find((candidate) => candidate.id === task.id);
      assert.equal(yield* Ref.get(sent), 0);
      assert.equal(after?.lastRunError, "Its sign-in was removed.");
    }).pipe(Effect.provide(scheduler(gate, sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a scheduled run nobody is there for never opens Accounts with a dialog; it waits", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const storage = memoryStore();
    // Scient may run with no window here: an open nobody can answer would ask the person.
    const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
    // Nothing saved yet: no pin to keep, so the run goes ahead, and no vault is made for it.
    const sentFresh = yield* Ref.make(0);
    const { service: fresh } = yield* makeHarness({ storage, keychain });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(hourly);
      yield* TestClock.adjust("1 hour");
      yield* TestClock.adjust("6 seconds");
      assert.equal(yield* Ref.get(sentFresh), 1);
      expect(reads).toEqual([]);
      expect(storage.blobs.size).toBe(0);
    }).pipe(
      Effect.provide(scheduler(realGate(fresh), sentFresh)),
      Effect.provide(SqlitePersistence.layerMemory),
    );

    const accountId = yield* savedPin(storage, keychain, hourly.id);
    // A cold start whose keychain would ask: the occurrence stays due, and nothing is sent.
    reads.length = 0;
    const { leases, atWindow } = yield* windowLeases();
    const { service: accounts } = yield* makeHarness({ storage, keychain, leases });
    const sent = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task: waiting } = yield* service.upsert(hourly);
      yield* TestClock.adjust("1 hour");
      yield* TestClock.adjust("6 seconds");
      assert.equal(yield* Ref.get(sent), 0);
      expect(reads).toEqual([]);
      const after = (yield* service.list()).tasks.find((task) => task.id === hourly.id);
      expect(after?.nextRunAt).toBe(waiting.nextRunAt);
      expect(after?.lastRunStatus).toBe(waiting.lastRunStatus);
      // The person's first use, at a window, opens Accounts; the waiting occurrence then runs,
      // under its pin.
      yield* atWindow(true);
      yield* accounts.recordCheck(accountId, { state: "signed-in" });
      expect(reads).toHaveLength(1);
      yield* TestClock.adjust("6 seconds");
      assert.equal(yield* Ref.get(sent), 1);
      expect(reads).toHaveLength(1);
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a webhook delivery on a cold start runs without opening Accounts", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
    yield* savedPin(storage, keychain, ScheduledTaskId.make("task:other"));
    // A cold start whose keychain would ask. A webhook task can never be pinned.
    reads.length = 0;
    const { service: accounts } = yield* makeHarness({ storage, keychain });
    const launched = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Deferred.succeed(launched, undefined).pipe(
                Effect.as({ threadId: "thread:hook", resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          realGate(accounts),
          NodeCrypto.layer,
          NodeCrypto.layerDigest,
          NodeCrypto.layerMac,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      // A new id: no pin can name it, so creating the task reads nothing from Accounts.
      const { task } = yield* service.upsert({
        ...hourly,
        id: undefined,
        threadId: undefined,
        schedule: { type: "webhook" },
      });
      const body = new TextEncoder().encode("{}");
      const accepted = yield* service.triggerWebhook({
        hookId: task.id,
        token: task.webhook?.path.split("/").at(-1) ?? "",
        method: "POST",
        path: `/api/hooks/${task.id}`,
        query: "",
        headers: { "content-type": "application/json" },
        body,
        bodyText: "{}",
      });
      assert.equal(accepted._tag, "accepted");
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.await(launched);
      // regression: the delivery read the task's pin, which opened Accounts with a dialog.
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a fixed-time occurrence waiting for Accounts runs once opened, however long it waited",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
      const storage = memoryStore();
      const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
      const daily = {
        ...hourly,
        id: ScheduledTaskId.make("task:daily"),
        schedule: { type: "fixed_time" as const, timeOfDay: "09:00" },
      };
      const accountId = yield* savedPin(storage, keychain, daily.id);
      reads.length = 0;
      const { leases, atWindow } = yield* windowLeases();
      const { service: accounts } = yield* makeHarness({ storage, keychain, leases });
      const sent = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(daily);
        yield* TestClock.setTime(Date.parse(task.nextRunAt!));
        // Well past the fixed-time grace, the scheduler up all along: the occurrence still waits.
        yield* TestClock.adjust("15 minutes");
        // Renamed meanwhile: the occurrence is the same one, and still waits.
        yield* service.upsert({ ...daily, title: "Daily hours" });
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(sent), 0);
        const waiting = (yield* service.list()).tasks.find(({ id }) => id === daily.id);
        expect(waiting?.nextRunAt).toBe(task.nextRunAt);
        expect(waiting?.lastRunError).toBeNull();
        // regression: the occurrence was dropped as missed while it waited for the person.
        yield* atWindow(true);
        yield* accounts.recordCheck(accountId, { state: "signed-in" });
        yield* TestClock.adjust("6 seconds");
        assert.equal(yield* Ref.get(sent), 1);
        expect(reads).toHaveLength(1);
      }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a Run now opens Accounts only with someone at a window to answer its dialog", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
    yield* savedPin(storage, keychain, hourly.id);
    reads.length = 0;
    const { leases, atWindow } = yield* windowLeases();
    const { service: accounts } = yield* makeHarness({ storage, keychain, leases });
    const sent = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(hourly);
      // An agent's Run now, say, with nobody at any window.
      const refused = yield* service.runNow({ id: hourly.id }).pipe(Effect.flip);
      // regression: Run now read the keychain whoever asked, with nobody there to answer.
      expect(refused.message).toBe(ACCOUNTS_AWAIT_PERSON);
      expect(reads).toEqual([]);
      assert.equal(yield* Ref.get(sent), 0);
      // Someone at a window: it opens Accounts, and runs under its pin.
      yield* atWindow(true);
      yield* service.runNow({ id: hourly.id });
      expect(reads).toHaveLength(1);
      assert.equal(yield* Ref.get(sent), 1);
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a webhook save that would read a pin waits while nobody can answer Accounts", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const storage = memoryStore();
    const { keychain, reads } = yield* recordingKeychain({ desktopBackgroundRunning: true });
    yield* savedPin(storage, keychain, hourly.id);
    reads.length = 0;
    const { leases, atWindow } = yield* windowLeases();
    const { service: accounts } = yield* makeHarness({ storage, keychain, leases });
    const sent = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      // An agent's schedule_task with a clientRequestId: the id it derives may carry a pin.
      const keyed = {
        ...hourly,
        id: undefined,
        commandId: CommandId.make("request:hook"),
        schedule: { type: "webhook" as const },
      };
      const waiting = yield* service.upsert(keyed).pipe(Effect.flip);
      // regression: the save read the keychain to look for the pin, with nobody there to answer.
      expect(waiting.message).toBe(ACCOUNTS_AWAIT_PERSON);
      expect(reads).toEqual([]);
      expect((yield* service.list()).tasks).toEqual([]);
      // Someone at a window: the pin is read; a retained one still refuses its id.
      yield* atWindow(true);
      const { task } = yield* service.upsert(keyed);
      expect(task.schedule.type).toBe("webhook");
      expect(reads).toHaveLength(1);
      const pinned = yield* service
        .upsert({ ...hourly, schedule: { type: "webhook" } })
        .pipe(Effect.flip);
      assert.equal(pinned.message, PINNED_WEBHOOK);
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "pins saved in an older shape never stop Accounts loading, and keep their task blocked",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      const { accountId } = yield* first.service.save(website());
      yield* first.service.updateTaskPin(hourly.id, () => ({
        scheduledTaskId: hourly.id,
        accountId,
        profileId: BrowserProfileId.make("default"),
        environmentId: "env-here",
        username: "synthetic-user",
        projectId,
      }));
      // The shapes an earlier build wrote: no username, and `waiting: true`.
      const sealed = storage.blobs.get("accounts-state")!;
      const text = new TextDecoder().decode(
        Redacted.value(yield* first.vault.decrypt("accounts-state", sealed)),
      );
      const stored = JSON.parse(text) as { taskPins: Array<Record<string, unknown>> };
      const [pin] = stored.taskPins;
      const { username: _username, ...noUsername } = pin!;
      stored.taskPins = [noUsername, { ...pin, scheduledTaskId: "task:other", waiting: true }];
      storage.blobs.set(
        "accounts-state",
        yield* first.vault.encrypt(
          "accounts-state",
          Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
        ),
      );
      // regression: either shape made the whole Accounts state unreadable.
      const { service: accounts } = yield* makeHarness({ storage });
      expect((yield* accounts.snapshot).accounts).toHaveLength(1);
      expect(yield* accounts.unreadableTaskPins).toEqual([hourly.id, "task:other"]);
      expect(
        (yield* accounts.activity({ target: { type: "account", accountId }, limit: 10 })).map(
          (entry) => entry.detail,
        ),
      ).toContain(`Scheduled task ${hourly.id}: its pin couldn't be read. Pin it again.`);
      const sent = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.upsert(hourly);
        yield* service.runNow({ id: hourly.id });
        assert.equal(yield* Ref.get(sent), 0);
        assert.equal(
          (yield* service.list()).tasks.find((task) => task.id === hourly.id)?.lastRunError,
          "This scheduled task's pin couldn't be read. Pin it again.",
        );
      }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
      // A cold start: the gate is the first to ask, before anything loaded the saved state.
      const { service: cold } = yield* makeHarness({ storage });
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.upsert({ ...hourly, id: ScheduledTaskId.make("task:other") });
        yield* service.runNow({ id: ScheduledTaskId.make("task:other") });
        // regression: the gate read the pins before they loaded, and let the run go.
        assert.equal(yield* Ref.get(sent), 0);
      }).pipe(Effect.provide(scheduler(realGate(cold), sent)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a pin list that isn't one keeps every unpinned task blocked until it is pinned", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const storage = memoryStore();
    const accountId = yield* savedPin(storage, noKeychain, hourly.id);
    const name = "accounts-state";
    const stored = yield* Effect.scoped(
      Effect.gen(function* () {
        const { vault } = yield* makeHarness({ storage });
        const text = Redacted.value(yield* vault.decrypt(name, storage.blobs.get(name)!));
        return JSON.parse(new TextDecoder().decode(text)) as { taskPins: Array<unknown> };
      }),
    );
    const [pin] = stored.taskPins;
    /** Reopens Accounts with the pins stored as `taskPins`. */
    const reopened = (taskPins: unknown) =>
      Effect.gen(function* () {
        const { vault } = yield* makeHarness({ storage });
        const json = JSON.stringify({ ...stored, taskPins });
        storage.blobs.set(
          name,
          yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(json))),
        );
        return (yield* makeHarness({ storage })).service;
      });
    // regression: a bare pin read as a list's one pin.
    expect(yield* (yield* reopened(pin)).taskPinOf(hourly.id)).toBe("unreadable");

    const accounts = yield* reopened({ hours: pin });
    const sent = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(hourly);
      // regression: the task ran, and could become a webhook task.
      yield* service.runNow({ id: hourly.id });
      assert.equal(yield* Ref.get(sent), 0);
      assert.equal(
        (yield* service.list()).tasks.find((task) => task.id === hourly.id)?.lastRunError,
        UNREADABLE_PIN,
      );
      const turned = yield* service
        .upsert({ ...hourly, schedule: { type: "webhook" } })
        .pipe(Effect.flip);
      assert.equal(turned.message, PINNED_WEBHOOK);
      const run = { projectId, unattended: true, scheduledTaskId: hourly.id };
      expect(
        (yield* accounts.authorizeUse(run, { type: "account", accountId }).pipe(Effect.flip))
          .message,
      ).toBe(UNREADABLE_PIN);
      // Pinned again, its own pin governs it.
      yield* accounts.updateTaskPin(hourly.id, () => pin as never);
      yield* accounts.recordCheck(accountId, { state: "signed-in" });
      yield* service.runNow({ id: hourly.id });
      assert.equal(yield* Ref.get(sent), 1);
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a verdict reached on one pin is never written onto the pin that replaced it", () =>
  Effect.gen(function* () {
    const { service: real } = yield* makeHarness();
    const { accountId } = yield* real.save(website());
    const pinned = {
      scheduledTaskId: hourly.id,
      accountId,
      profileId: BrowserProfileId.make("default"),
      username: "synthetic-user",
      projectId,
    };
    // Pinned to a sign-in on another computer: the gate refuses it.
    yield* real.updateTaskPin(hourly.id, () => ({ ...pinned, environmentId: "env-elsewhere" }));
    let repinned = false;
    // While the gate decides, the task is pinned again, here.
    const accounts = AccountsService.of({
      ...real,
      snapshot: real.snapshot.pipe(
        Effect.tap(() =>
          repinned
            ? Effect.void
            : Effect.suspend(() => {
                repinned = true;
                return real.updateTaskPin(hourly.id, () => ({
                  ...pinned,
                  environmentId: "env-here",
                }));
              }),
        ),
      ),
    });
    const gate = yield* Layer.build(realGate(accounts)).pipe(
      Effect.map((context) => Context.get(context, ScheduledRunGate)),
    );
    yield* gate.beforeRun({ id: hourly.id, projectId, threadId: null });
    // regression: the replacement took the old pin's "not allowed" as its own last run.
    expect((yield* real.taskPins)[0]).toMatchObject({ environmentId: "env-here" });
    expect((yield* real.taskPins)[0]?.last).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("a pinned task can't be turned into a webhook task", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const sent = yield* Ref.make(0);
    const { service: accounts } = yield* makeHarness();
    const { accountId } = yield* accounts.save(website());
    yield* accounts.updateTaskPin(hourly.id, () => ({
      scheduledTaskId: hourly.id,
      accountId,
      profileId: BrowserProfileId.make("default"),
      environmentId: "env-here",
      username: "synthetic-user",
      projectId,
    }));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(hourly);
      const turned = yield* service
        .upsert({ ...hourly, schedule: { type: "webhook" } })
        .pipe(Effect.flip);
      // regression: the edit went through, and a delivery the pin blocked could never be replayed.
      assert.equal(turned.message, PINNED_WEBHOOK);
      const kept = (yield* service.list()).tasks.find((task) => task.id === hourly.id);
      assert.equal(kept?.schedule.type, "interval");
      // Deleted, the task leaves its pin in Accounts: a new webhook task under its id would get it.
      yield* service.delete({ id: hourly.id });
      const recreated = yield* service
        .upsert({ ...hourly, schedule: { type: "webhook" } })
        .pipe(Effect.flip);
      // regression: the new webhook task took the deleted task's pin.
      assert.equal(recreated.message, PINNED_WEBHOOK);
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a trigger edit waits for a pin of the same task, then sees it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const sent = yield* Ref.make(0);
    const { service: accounts } = yield* makeHarness();
    const { accountId } = yield* accounts.save(website());
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(hourly);
      // A pin under way: it has read the trigger (not a webhook) and is about to write.
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pinning = yield* accounts
        .withTaskEdit(
          hourly.id,
          Effect.gen(function* () {
            yield* Deferred.succeed(holding, undefined);
            yield* Deferred.await(release);
            yield* accounts.updateTaskPin(hourly.id, () => ({
              scheduledTaskId: hourly.id,
              accountId,
              profileId: BrowserProfileId.make("default"),
              environmentId: "env-here",
              username: "synthetic-user",
              projectId,
            }));
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      const edit = yield* service
        .upsert({ ...hourly, schedule: { type: "webhook" } })
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pinning);
      const result = yield* Fiber.join(edit);
      // regression: the edit read "not pinned" while the pin was being written, and both landed.
      assert.isTrue(result._tag === "Failure");
      const kept = (yield* service.list()).tasks.find((task) => task.id === hourly.id);
      assert.equal(kept?.schedule.type, "interval");
    }).pipe(Effect.provide(scheduler(realGate(accounts), sent)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
