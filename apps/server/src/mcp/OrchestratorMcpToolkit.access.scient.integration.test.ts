import { CommandId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import {
  claudeInstanceId,
  codexInstanceId,
  codexModel,
  codexSelection,
  declaredFailure,
  heldCallerPrefix,
  parentThreadId,
  projectId,
  makeWithToolkit,
} from "./orchestratorMcpToolkit.scient.testkit.ts";

const withToolkit = makeWithToolkit(Effect.service(McpServer.McpServer));

describe("orchestrator MCP access", () => {
  it.live("advertises each tool's side effects and rejects an unknown inspect argument", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        yield* fx.startParent;
        const annotations = (name: string) =>
          fx.server.tools.find(({ tool }) => tool.name === name)?.tool.annotations;
        // task_status and inspect acknowledge delivered results, so neither is read-only.
        for (const [name, expected] of [
          ["task_status", { readOnlyHint: false, idempotentHint: true }],
          ["scient_thread_inspect", { readOnlyHint: false }],
          ["orchestrator_capabilities", { readOnlyHint: true, idempotentHint: true }],
          ["delegate_task", { destructiveHint: true, openWorldHint: true }],
          ["create_threads", { destructiveHint: true }],
          ["scient_thread_list", { readOnlyHint: true, idempotentHint: true }],
          ["scient_thread_update", { destructiveHint: true, idempotentHint: false }],
          ["scient_thread_send", { destructiveHint: true }],
          ["scient_thread_wait", { readOnlyHint: true }],
          ["scient_thread_interrupt", { destructiveHint: true }],
          ["schedule_task", { destructiveHint: true }],
        ] as const) {
          expect(annotations(name), name).toMatchObject(expected);
        }
        expect(
          fx.server.tools.find(({ tool }) => tool.name === "scient_thread_update")?.tool
            .inputSchema,
        ).toMatchObject({
          type: "object",
          properties: { action: expect.any(Object), title: expect.any(Object) },
        });
        const unknownArgument = yield* fx
          .invoke("scient_thread_inspect", { threadId: parentThreadId, cursor: 90 })
          .pipe(Effect.flip);
        expect(unknownArgument.message).toContain('Unknown argument "cursor"');
      }),
    ),
  );

  it.live("lets a thread credential's grants, not the client, decide inspect and update", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        yield* fx.startParent;
        const live = yield* fx.callerScopeFor(parentThreadId);
        expect(
          declaredFailure(
            yield* fx.invokeAs(
              { ...live, capabilities: new Set(["threads:read"]) },
              "scient_thread_inspect",
              { threadId: parentThreadId },
            ),
          ),
        ).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
        expect(
          (yield* fx.invokeAs(live, "scient_thread_inspect", { threadId: parentThreadId })).isError,
        ).toBe(false);

        const denied = yield* fx.invokeAs(
          { ...live, capabilities: new Set() },
          "scient_thread_update",
          { action: "rename", title: "Denied title" },
        );
        expect(declaredFailure(denied)).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "capability_denied",
        });
        expect((yield* fx.orchestrator.getThreadShell(parentThreadId))?.title).toBe("MCP parent");
        const allowed = yield* fx.invokeAs(live, "scient_thread_update", {
          action: "rename",
          title: "Granted title",
        });
        expect(allowed.isError).toBe(false);
        expect((yield* fx.orchestrator.getThreadShell(parentThreadId))?.title).toBe(
          "Granted title",
        );
      }),
    ),
  );

  it.live("publishes capabilities from the caller's adapter and each provider's models", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        yield* fx.startParent;
        const capabilities = yield* fx.invoke("orchestrator_capabilities", {});
        expect(capabilities.isError).toBe(false);
        expect(capabilities.structuredContent).toMatchObject({
          inheritedProviderInstanceId: codexInstanceId,
          inheritedModel: codexModel,
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
          },
          providers: expect.arrayContaining([
            expect.objectContaining({
              providerInstanceId: claudeInstanceId,
              canRunCrossProviderChildTask: true,
            }),
            expect.objectContaining({ providerInstanceId: "opencode", canRunChildTask: false }),
            expect.objectContaining({
              providerInstanceId: codexInstanceId,
              models: [
                expect.objectContaining({
                  id: codexModel,
                  options: [{ id: "reasoning", values: ["low", "medium", "high"] }],
                }),
              ],
            }),
          ]),
        });
      }),
    ),
  );

  it.live(
    "saves, lists, updates and deletes a bound scheduled task and decodes a serialized schedule",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const created = yield* fx.invoke("schedule_task", {
            prompt: "wake up in this thread and say hello",
            schedule: { type: "interval", everyMs: 60_000 },
            clientRequestId: "schedule-hello-1",
          });
          expect(created.isError).toBe(false);
          expect(created.structuredContent).toMatchObject({
            boundThreadId: parentThreadId,
            projectId,
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            title: "wake up in this thread and say hello",
          });
          const scheduledTaskId = (created.structuredContent as { scheduledTaskId: string })
            .scheduledTaskId;
          expect(yield* Ref.get(fx.scheduledStore)).toMatchObject([
            {
              threadId: parentThreadId,
              projectId,
              createdBy: "agent",
              creationSource: "mcp",
              modelSelection: codexSelection,
            },
          ]);
          const listed = yield* fx.invoke("list_scheduled_tasks", {});
          expect(listed.isError).toBe(false);
          expect(listed.structuredContent).toMatchObject({
            tasks: [{ scheduledTaskId, boundThreadId: parentThreadId }],
          });

          // A caller within the ceiling can edit and unbind normally.
          const unbound = yield* fx.invoke("schedule_task", {
            scheduledTaskId,
            prompt: "updated safe scheduled instructions",
            bindToCurrentThread: false,
          });
          expect(unbound.isError).toBe(false);
          expect((yield* Ref.get(fx.scheduledStore))[0]).toMatchObject({
            prompt: "updated safe scheduled instructions",
            threadId: null,
            runtimeMode: "full-access",
            interactionMode: "default",
          });
          const disabled = yield* fx.invoke("schedule_task", { scheduledTaskId, enabled: false });
          expect(disabled.structuredContent).toMatchObject({ scheduledTaskId, enabled: false });
          const deleted = yield* fx.invoke("delete_scheduled_task", { scheduledTaskId });
          expect(deleted.structuredContent).toMatchObject({ scheduledTaskId, deleted: true });
          expect(yield* Ref.get(fx.scheduledStore)).toHaveLength(0);

          // OpenCode 1.15 has emitted this exact nested-object-as-JSON-string
          // shape. Decode it at the MCP boundary rather than failing a task
          // the model otherwise specified correctly.
          const serialized = yield* fx.invoke("schedule_task", {
            prompt: "check for new pull requests",
            schedule: '{"type":"interval","everyMs":3600000}',
            clientRequestId: "schedule-opencode-compat-1",
          });
          expect(serialized.isError).toBe(false);
          expect(serialized.structuredContent).toMatchObject({
            schedule: { type: "interval", everyMs: 3_600_000 },
            boundThreadId: parentThreadId,
          });
        }),
      ),
  );

  it.live.each([
    {
      suffix: "supervised",
      runtimeMode: "approval-required",
      interactionMode: "default",
      expectedCode: "runtime_mode_escalation_denied",
    },
    {
      suffix: "plan",
      runtimeMode: "full-access",
      interactionMode: "plan",
      expectedCode: "interaction_mode_escalation_denied",
    },
  ] as const)(
    "keeps a $suffix caller's issued ceiling after its thread's defaults broaden",
    ({ suffix, runtimeMode, interactionMode, expectedCode }) =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const parentTask = yield* fx.invoke("schedule_task", {
            prompt: "wake up in this thread and say hello",
            schedule: { type: "interval", everyMs: 60_000 },
            clientRequestId: "schedule-hello-1",
          });
          const scheduledTaskId = (parentTask.structuredContent as { scheduledTaskId: string })
            .scheduledTaskId;
          // The parent's full grant reaches the project service, which then refuses.
          const fullCallerProject = yield* fx.invoke("scient_project_update", {
            projectId,
            title: "Authorized project mutation",
          });
          expect(declaredFailure(fullCallerProject)).toMatchObject({ code: "invalid_request" });
          expect(yield* Ref.get(fx.projectWrites)).toBe(1);

          const callerThreadId = ThreadId.make(`${heldCallerPrefix}${suffix}`);
          yield* fx.startThread({
            threadId: callerThreadId,
            title: "Scheduled task caller",
            text: "Keep the captured caller policy active.",
            runtimeMode,
            interactionMode,
          });
          const callerScope = yield* fx.callerScopeFor(callerThreadId);
          const otherTasks = () =>
            Ref.get(fx.scheduledStore).pipe(
              Effect.map((tasks) => tasks.filter((task) => task.id !== scheduledTaskId)),
            );
          for (const bindToCurrentThread of [true, false]) {
            const created = yield* fx.invokeAs(callerScope, "schedule_task", {
              prompt: "work within the caller ceiling",
              schedule: { type: "interval", everyMs: 60_000 },
              bindToCurrentThread,
              clientRequestId: `ceiling-${suffix}-${bindToCurrentThread}`,
            });
            expect(created.isError).toBe(false);
            const [inherited] = yield* otherTasks();
            expect(inherited).toMatchObject({
              runtimeMode,
              interactionMode,
              threadId: bindToCurrentThread ? callerThreadId : null,
            });
            yield* fx.invokeAs(callerScope, "delete_scheduled_task", {
              scheduledTaskId: inherited!.id,
            });
          }

          // Future defaults cannot grant this still-running caller more authority.
          yield* fx.orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`command:mcp-scheduled-${suffix}:future-access`),
            threadId: callerThreadId,
            runtimeMode: "full-access",
          });
          yield* fx.orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`command:mcp-scheduled-${suffix}:future-interaction`),
            threadId: callerThreadId,
            interactionMode: "default",
          });
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          expect(yield* manager.resolveMcpInvocationPolicy(callerScope.thread)).toEqual(
            Option.some({ runtimeMode, interactionMode }),
          );

          // A bearer webhook must remain hidden after mutable defaults broaden.
          const webhookTask = {
            ...(yield* Ref.get(fx.scheduledStore))[0]!,
            id: ScheduledTaskId.make(`scheduled-task:captured-webhook-${suffix}`),
            threadId: null,
            schedule: { type: "webhook" as const, signature: null },
            webhook: {
              path: "/hooks/captured-policy",
              url: "https://scient.test/hooks/captured-policy",
              hasSecret: false,
            },
          };
          yield* Ref.update(fx.scheduledStore, (tasks) => [...tasks, webhookTask]);
          const webhookList = yield* fx.invokeAs(callerScope, "list_scheduled_tasks", {
            projectId,
          });
          const webhookSummary = (
            webhookList.structuredContent as {
              tasks: readonly { scheduledTaskId: string; webhookUrl?: string }[];
            }
          ).tasks.find((task) => task.scheduledTaskId === webhookTask.id);
          expect(webhookSummary).toBeDefined();
          expect(webhookSummary?.webhookUrl).toBeUndefined();
          yield* Ref.update(fx.scheduledStore, (tasks) =>
            tasks.filter((task) => task.id !== webhookTask.id),
          );

          const expectDenied = (args: Record<string, unknown>, code: string = expectedCode) =>
            Effect.gen(function* () {
              const before = yield* Ref.get(fx.scheduledStore);
              expect(
                declaredFailure(yield* fx.invokeAs(callerScope, "schedule_task", args)),
              ).toMatchObject({ code });
              expect(yield* Ref.get(fx.scheduledStore)).toEqual(before);
            });
          for (const binding of [undefined, false, true]) {
            yield* expectDenied({
              scheduledTaskId,
              prompt: "Cannot inherit future thread defaults.",
              ...(binding === undefined ? {} : { bindToCurrentThread: binding }),
            });
          }
          const beforeProjectWrites = yield* Ref.get(fx.projectWrites);
          const deniedProject = yield* fx.invokeAs(callerScope, "scient_project_update", {
            projectId,
            title: "Cannot upgrade the running caller's project authority.",
          });
          expect(declaredFailure(deniedProject)).toMatchObject({ code: "capability_denied" });
          expect(yield* Ref.get(fx.projectWrites)).toBe(beforeProjectWrites);

          const safeFuture = yield* fx.invokeAs(callerScope, "schedule_task", {
            prompt: "Unbound work inherits the running caller's captured ceiling.",
            schedule: { type: "interval", everyMs: 60_000 },
            bindToCurrentThread: false,
            clientRequestId: `captured-future-${suffix}`,
          });
          expect(safeFuture.structuredContent).toHaveProperty("scheduledTaskId");
          const [futureTask] = yield* otherTasks();
          expect(futureTask).toMatchObject({ runtimeMode, interactionMode, threadId: null });
          yield* expectDenied({
            scheduledTaskId: futureTask!.id,
            bindToCurrentThread: true,
            prompt: "Cannot rebind captured restricted work to broader future defaults.",
          });
          yield* fx.invokeAs(callerScope, "delete_scheduled_task", {
            scheduledTaskId: futureTask!.id,
          });
          yield* expectDenied({
            prompt: "Cannot bind weaker caller work into a stronger current default.",
            schedule: { type: "interval", everyMs: 60_000 },
          });

          for (const foreignScope of [
            {
              ...callerScope,
              thread: { ...callerScope.thread, providerSessionId: "foreign-credential" },
            },
            {
              ...callerScope,
              thread: { ...callerScope.thread, providerInstanceId: claudeInstanceId },
            },
            { ...callerScope, thread: { ...callerScope.thread, threadId: parentThreadId } },
          ]) {
            expect(
              Option.isNone(yield* manager.resolveMcpInvocationPolicy(foreignScope.thread)),
            ).toBe(true);
            const denied = yield* fx.invokeAs(foreignScope, "schedule_task", {
              scheduledTaskId,
              prompt: "foreign",
            });
            expect(declaredFailure(denied)).toMatchObject({ code: "parent_not_active" });
          }
        }),
      ),
  );

  it.live(
    "records one secret card, returns only a ref, replays the same request and issues the ref to its project",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const secretRequests = yield* SecretRequests.SecretRequests;
          const request = {
            label: "GitHub webhook secret",
            reason: "Signs release webhooks. Enter the same value in GitHub's webhook settings.",
            clientRequestId: "release-webhook-secret",
          };
          const secretFiber = yield* fx
            .invoke("request_secret", { ...request, placeholder: "Paste the webhook secret" })
            .pipe(Effect.forkChild);
          const asked = yield* fx.waitForDurable(parentThreadId, (projection) =>
            projection.turnItems.some(
              (item) => item.type === "secret_request" && item.secretStatus === "pending",
            ),
          );
          const card = asked.turnItems.find((item) => item.type === "secret_request");
          if (card?.type !== "secret_request") {
            return yield* Effect.die(new Error("Secret request card missing."));
          }
          expect(card).toMatchObject({
            label: "GitHub webhook secret",
            placeholder: "Paste the webhook secret",
          });
          // A replayed record cannot rewrite the card the user sees.
          yield* fx.orchestrator.dispatch({
            type: "secret_request.record",
            commandId: CommandId.make("command:test:secret-request-replay"),
            threadId: parentThreadId,
            runId: card.runId!,
            nodeId: card.nodeId!,
            turnItemId: card.id,
            label: "Something else",
            reason: "A different reason.",
            secretStatus: "pending",
          });
          expect(
            (yield* fx.projection(parentThreadId)).turnItems.find((item) => item.id === card.id),
          ).toMatchObject({ label: "GitHub webhook secret", runId: card.runId });
          expect(
            (yield* fx.orchestrator.getThreadShell(parentThreadId))?.pendingRuntimeRequest,
          ).toMatchObject({ kind: "user_input" });
          expect(
            threadShellFromProjection(asked, threadPullRequestsOf).pendingRuntimeRequest,
          ).toMatchObject({ kind: "user_input" });

          yield* secretRequests.answer({
            threadId: parentThreadId,
            turnItemId: card.id,
            answer: { type: "save", secret: "github-webhook-secret" },
          });
          const secretCall = yield* Fiber.join(secretFiber);
          expect(secretCall.isError).toBe(false);
          const secretResult = secretCall.structuredContent as {
            status: string;
            secretRef?: string;
          };
          expect(secretResult.status).toBe("saved");
          expect(secretResult.secretRef).toMatch(/^secret-ref:[0-9a-f]{32}$/);
          expect(
            (yield* fx.orchestrator.getThreadShell(parentThreadId))?.pendingRuntimeRequest ?? null,
          ).toBeNull();
          const received = [
            ...secretCall.content.map((part) => ("text" in part ? part.text : "")),
            ...Object.values(secretResult),
          ];
          expect(received.some((value) => value.includes("github-webhook-secret"))).toBe(false);

          const retried = yield* fx.invoke("request_secret", request);
          expect(retried.structuredContent).toEqual(secretResult);
          expect(
            (yield* fx.projection(parentThreadId)).turnItems.filter(
              (item) => item.type === "secret_request",
            ),
          ).toHaveLength(1);
          expect(
            yield* secretRequests.consume({ ref: secretResult.secretRef as never, projectId }),
          ).toBe("github-webhook-secret");
        }),
      ),
  );
});
