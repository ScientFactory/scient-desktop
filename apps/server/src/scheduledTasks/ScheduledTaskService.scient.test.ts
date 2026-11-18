import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

it.effect("Run now on a paused one-time task keeps it; its due run still removes it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const projectId = ProjectId.make("project:test");
    const ended = yield* Deferred.make<void>();
    const sent = yield* Ref.make(new Map<string, string>());
    const run = { id: "run:1", status: "completed", rootNodeId: "node:root" };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.update(sent, (all) => new Map(all).set(input.threadId, input.messageId)).pipe(
                Effect.as({} as never),
              ),
            getThreadShell: () =>
              Effect.succeed({ projectId, archivedAt: null, deletedAt: null } as never),
            getProjectThreadRecords: (thread) =>
              Effect.map(
                Ref.get(sent),
                (all) => ({ runs: [{ ...run, userMessageId: all.get(thread.threadId) }] }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.as({ threadId: input.threadId, run, timedOut: false } as never),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const task = (id: string, enabled: boolean, runAt: string) =>
        service.upsert({
          id: ScheduledTaskId.make(id),
          title: id,
          prompt: "Draft the release notes",
          enabled,
          schedule: { type: "once", runAt },
          projectId,
          threadId: ThreadId.make(`thread:${id}`),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const paused = (yield* task("task:paused", false, "2026-12-01T07:00:00.000Z")).task;
      const due = (yield* task("task:due", true, "2026-11-01T07:01:00.000Z")).task;
      yield* Deferred.succeed(ended, undefined);

      yield* service.runNow({ id: paused.id });
      const dueRemoved = yield* service.subscribeList().pipe(
        Stream.filter(({ tasks }) => tasks.every((candidate) => candidate.id !== due.id)),
        Stream.runHead,
        Effect.forkChild,
      );
      // The paused run's outcome is ready before the due run starts, so it has settled by the
      // time the due task's removal is seen.
      yield* TestClock.adjust("2 minutes");
      yield* Fiber.join(dueRemoved);

      const kept = (yield* service.list()).tasks.find((candidate) => candidate.id === paused.id);
      assert.equal(kept?.lastRunStatus, "succeeded");
      assert.equal(kept?.schedule.type, "once");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
