import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  makeWakeHarness,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  awaitUntil,
  makeSubagentNotificationFrame,
  makeResultFrame,
  makeAssistantTextFrame,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("projects native workflow phases and stable inert member slots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now,
            attemptId: RunAttemptId.make("workflow-presentation-attempt"),
            text: "Run a workflow",
            attachments: [],
          }),
        );
        const taskId = "workflow-verification";
        yield* Queue.offer(
          h.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            task_type: "local_workflow",
            description: "Verification",
            workflow_name: "Audit",
            subagent_type: "researcher",
            tool_use_id: "workflow-tool",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const progress = claudeSdkFrame({
          type: "system",
          subtype: "task_progress",
          task_id: taskId,
          description: "Checking",
          usage: { total_tokens: 100, input_tokens: 80, tool_uses: 3 },
          last_tool_name: "Read",
          workflow_progress: [
            { type: "workflow_phase", index: 0, title: "Inspect" },
            {
              type: "workflow_agent",
              index: 0,
              state: "done",
              label: "Reader",
              phaseIndex: 0,
              phaseTitle: "Inspect",
              model: "claude/reader",
              attempt: 1,
              tokens: 40,
              toolCalls: 2,
            },
            { type: "workflow_agent", index: 1, state: "pending", label: "Auditor", phaseIndex: 0 },
          ],
          uuid: "00000000-0000-4000-8000-000000000902",
          session_id: WAKE_NATIVE_SESSION,
        });
        yield* Queue.offer(h.sdkMessages, progress);
        yield* Queue.offer(h.sdkMessages, progress);
        yield* awaitUntil(
          () =>
            h.events.filter(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.presentation?.kind === "workflow_agent",
            ).length === 2,
          "two unique workflow members",
        );
        const native = h.events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent] : [],
        );
        const coordinator = native.findLast((agent) => agent.presentation?.kind === "workflow");
        assert.isDefined(coordinator);
        assert.deepEqual(coordinator?.presentation?.phases, [{ index: 0, title: "Inspect" }]);
        assert.equal(coordinator?.presentation?.usage?.totalTokens, 100);
        assert.equal(coordinator?.presentation?.role, "researcher");
        const members = native.filter((agent) => agent.presentation?.kind === "workflow_agent");
        assert.lengthOf(members, 2);
        assert.equal(members[0]?.presentation?.workflowId, coordinator?.id);
        assert.equal(members[0]?.presentation?.usage?.toolUses, 2);
        assert.equal(members[0]?.model, "claude/reader");
        assert.isTrue(
          members.every((agent) => agent.nativeTaskRef === null && agent.childThreadId === null),
        );
        const firstTerminal = members[0]?.completedAt;
        yield* Queue.offer(
          h.sdkMessages,
          makeSubagentNotificationFrame({
            taskId,
            toolUseId: "workflow-tool",
            summary: "Verified",
            uuid: "00000000-0000-4000-8000-000000000903",
          }),
        );
        yield* Queue.offer(
          h.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000904", result: "Done" }),
        );
        yield* awaitUntil(() => h.terminalEvents().length === 1, "workflow root terminal");
        const final = h.events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent] : [],
        );
        assert.equal(
          final.findLast((agent) => agent.id === members[0]?.id)?.completedAt,
          firstTerminal,
        );
        assert.equal(final.findLast((agent) => agent.id === members[1]?.id)?.status, "completed");
        assert.equal(
          final.findLast((agent) => agent.id === coordinator?.id)?.presentation?.kind,
          "workflow",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect("rejects late workflow members until an authoritative coordinator activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("workflow-late-attempt"),
            text: "Workflow",
            attachments: [],
          }),
        );
        const taskId = "workflow-late";
        const started = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: taskId,
          task_type: "local_workflow",
          description: "Audit",
          tool_use_id: "late-tool",
          uuid: "00000000-0000-4000-8000-000000000911",
          session_id: WAKE_NATIVE_SESSION,
        });
        const progress = (attempt: number, index = 0) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: taskId,
            description: "Checking",
            workflow_progress: [
              {
                type: "workflow_agent",
                index,
                state: "running",
                startedAt: "2026-10-04T00:00:00.000Z",
                attempt,
              },
            ],
            uuid: "00000000-0000-4000-8000-000000000912",
            session_id: WAKE_NATIVE_SESSION,
          });
        yield* h.offerAndWait(started);
        yield* h.offerAndWait(progress(1));
        yield* h.offerAndWait(
          claudeSdkFrame({ ...started, task_id: "unrelated-workflow", tool_use_id: "other-tool" }),
        );
        yield* h.offerAndWait(claudeSdkFrame({ ...progress(1), task_id: "unrelated-workflow" }));
        const coordinatorId = (yield* IdAllocator.IdAllocatorV2).derive.nodeFromProviderItem({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeItemId: `task:${taskId}`,
        });
        yield* h.offerAndWait(
          makeSubagentNotificationFrame({
            taskId,
            toolUseId: "late-tool",
            summary: "Finished",
            uuid: "00000000-0000-4000-8000-000000000913",
          }),
        );
        yield* h.offerAndWait(progress(9));
        yield* h.offerAndWait(progress(1, 1));
        yield* h.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000914",
            text: "workflow late-frame barrier",
          }),
        );
        yield* awaitUntil(
          () =>
            h.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.text === "workflow late-frame barrier",
            ),
          "late progress output barrier",
        );
        const before = h.events.flatMap((event) =>
          event.type === "subagent.updated" &&
          event.subagent.presentation?.workflowId === coordinatorId
            ? [event.subagent]
            : [],
        );
        assert.deepEqual(
          before.map((member) => member.status),
          ["running", "completed"],
        );
        assert.equal(new Set(before.map((member) => member.id)).size, 1);
        assert.equal(
          h.events.findLast(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.presentation?.kind === "workflow_agent" &&
              event.subagent.parentNodeId !== coordinatorId,
          )?.type,
          "subagent.updated",
        );
        const unrelated = h.events
          .flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.presentation?.kind === "workflow_agent" &&
            event.subagent.parentNodeId !== coordinatorId
              ? [event.subagent]
              : [],
          )
          .at(-1);
        assert.equal(unrelated?.status, "running");
        yield* h.offerAndWait(started);
        yield* h.offerAndWait(progress(1));
        yield* awaitUntil(
          () =>
            h.events.filter(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.presentation?.workflowId === coordinatorId,
            ).length === 3,
          "authoritative workflow activation",
        );
        const reopened = h.events
          .flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.presentation?.workflowId === coordinatorId
              ? [event.subagent]
              : [],
          )
          .at(-1);
        assert.equal(reopened?.status, "running");
        assert.equal(reopened?.presentation?.activationCount, 2);
        assert.isNull(reopened?.completedAt);
        assert.equal(reopened?.presentation?.firstSeenAt, before[0]?.presentation?.firstSeenAt);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect(
    "preserves count-only workflow observations and progress buffered before idle activation drain",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          yield* h.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now,
              attemptId: RunAttemptId.make("workflow-counts-first"),
              text: "Audit",
              attachments: [],
            }),
          );
          const started = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "count-workflow",
            task_type: "local_workflow",
            description: "Audit",
            tool_use_id: "count-tool",
            uuid: "00000000-0000-4000-8000-000000000971",
            session_id: WAKE_NATIVE_SESSION,
          });
          const progress = (tokens: number | undefined, toolCalls: number) =>
            claudeSdkFrame({
              type: "system",
              subtype: "task_progress",
              task_id: "count-workflow",
              description: "Inspect",
              workflow_progress: [
                {
                  type: "workflow_agent",
                  index: 0,
                  state: "running",
                  attempt: 1,
                  startedAt: "2026-10-04T00:00:00.000Z",
                  ...(tokens === undefined ? {} : { tokens }),
                  toolCalls,
                },
              ],
              uuid: "00000000-0000-4000-8000-000000000972",
              session_id: WAKE_NATIVE_SESSION,
            });
          const members = () =>
            h.events.flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.presentation?.kind === "workflow_agent"
                ? [event.subagent]
                : [],
            );
          yield* h.offerAndWait(started);
          yield* h.offerAndWait(progress(undefined, 2));
          yield* awaitUntil(() => members().length === 1, "count-only member receipt");
          assert.deepEqual(members().at(-1)?.presentation?.usage, { toolUses: 2 });
          const firstSeen = members().at(-1)?.presentation?.firstSeenAt;
          yield* h.offerAndWait(progress(40, 2));
          yield* h.offerAndWait(progress(undefined, 5));
          yield* awaitUntil(
            () => members().at(-1)?.presentation?.usage?.toolUses === 5,
            "sparse tool count receipt",
          );
          assert.deepEqual(members().at(-1)?.presentation?.usage, { totalTokens: 40, toolUses: 5 });
          yield* h.offerAndWait(
            makeSubagentNotificationFrame({
              taskId: "count-workflow",
              toolUseId: "count-tool",
              summary: "Done",
              uuid: "00000000-0000-4000-8000-000000000973",
            }),
          );
          yield* h.offerAndWait(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000974", result: "Done" }),
          );
          yield* Queue.take(h.terminalReceipts);
          // The authoritative start is buffered while root is idle. Progress must
          // travel with it, rather than be consumed against the old terminal context.
          yield* h.offerAndWait(started);
          yield* h.offerAndWait(progress(60, 7));
          yield* h.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now,
              attemptId: RunAttemptId.make("workflow-counts-continuation"),
              text: "Continue",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => members().at(-1)?.presentation?.usage?.totalTokens === 60,
            "buffered workflow progress after activation",
          );
          const reopened = members().at(-1);
          assert.equal(reopened?.status, "running");
          assert.equal(reopened?.presentation?.activationCount, 2);
          assert.equal(reopened?.presentation?.firstSeenAt, firstSeen);
          assert.deepEqual(reopened?.presentation?.usage, { totalTokens: 60, toolUses: 7 });
          assert.lengthOf(h.offeredMessages, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect.each(["failed", "interrupted"] as const)(
    "settles workflow members on native query %s lifecycle",
    (status) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeWakeHarnessWithOptions({
            close: (messages) => Queue.shutdown(messages),
          });
          yield* h.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`workflow-query-${status}`),
              text: "Workflow",
              attachments: [],
            }),
          );
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "query-workflow",
              task_type: "local_workflow",
              description: "Audit",
              uuid: "00000000-0000-4000-8000-000000000921",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_progress",
              task_id: "query-workflow",
              description: "Checking",
              workflow_progress: [
                {
                  type: "workflow_agent",
                  index: 0,
                  state: "running",
                  startedAt: "2026-10-04T00:00:00.000Z",
                  attempt: 1,
                },
              ],
              uuid: "00000000-0000-4000-8000-000000000922",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          if (status === "interrupted") {
            yield* awaitUntil(
              () => h.events.some((event) => event.type === "provider_turn.updated"),
              "native provider turn receipt",
            );
            const providerTurn = h.events.findLast(
              (event) => event.type === "provider_turn.updated",
            );
            assert.isTrue(providerTurn?.type === "provider_turn.updated");
            if (providerTurn?.type !== "provider_turn.updated") return;
            yield* h.runtime.interruptTurn({
              providerThread: h.providerThread,
              providerTurnId: providerTurn.providerTurn.id,
            });
          } else yield* Queue.shutdown(h.sdkMessages);
          yield* Queue.take(h.terminalReceipts);
          const members = h.events.flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.presentation?.kind === "workflow_agent"
              ? [event.subagent]
              : [],
          );
          assert.equal(members.at(-1)?.status, status);
          assert.isNotNull(members.at(-1)?.completedAt);
          assert.isFalse(yield* h.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );
});
