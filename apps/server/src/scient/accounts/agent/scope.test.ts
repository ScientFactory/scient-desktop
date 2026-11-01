import { MessageId, ProjectId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { deriveAccountSessionScope } from "./scope.ts";

it("derives unattended authority from the active run's initiating scheduled message and fails closed when unknown", () => {
  const scheduled = {
    id: MessageId.make("message-scheduled"),
    scheduledTaskId: ScheduledTaskId.make("task-fixture"),
  };
  const interactive = { id: MessageId.make("message-interactive") };
  const run = {
    id: RunId.make("run-fixture"),
    ordinal: 1,
    status: "running" as const,
    userMessageId: scheduled.id,
  };
  const threadId = ThreadId.make("thread-fixture");
  const projectId = ProjectId.make("project-fixture");
  expect(deriveAccountSessionScope(threadId, projectId, [run], [scheduled, interactive])).toEqual({
    threadId,
    projectId,
    unattended: true,
  });
  expect(
    deriveAccountSessionScope(
      threadId,
      projectId,
      [{ ...run, userMessageId: interactive.id }],
      [scheduled, interactive],
    ).unattended,
  ).toBe(false);
  expect(
    deriveAccountSessionScope(
      threadId,
      projectId,
      [{ ...run, ordinal: 2, userMessageId: interactive.id }, run],
      [interactive, scheduled],
    ).unattended,
  ).toBe(true);
  expect(
    deriveAccountSessionScope(threadId, projectId, [{ ...run, status: "completed" }], [scheduled])
      .unattended,
  ).toBe(true);
});
