import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { McpServer } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  cancellationPrompt,
  claudeInstanceId,
  claudeModel,
  codexInstanceId,
  codexModel,
  createdThreadPrompt,
  decodeCreateThreadsResult,
  decodeThreadInterruptResult,
  decodeThreadListResult,
  decodeThreadReadResult,
  decodeThreadSendResult,
  decodeThreadUpdateResult,
  decodeThreadWaitResult,
  declaredFailure,
  delegatedPrompt,
  parentThreadId,
  projectId,
  type ToolkitFixture,
  makeWithToolkit,
} from "./orchestratorMcpToolkit.scient.testkit.ts";

const withToolkit = makeWithToolkit(Effect.service(McpServer.McpServer));

const batchInput = {
  clientRequestId: "create-thread-batch-1",
  threads: [
    { title: "Inherited empty thread" },
    {
      title: "Claude ordinary thread",
      prompt: createdThreadPrompt,
      target: { driverKind: "claudeAgent" },
    },
  ],
};

/** Creates an empty Codex thread and a prompted Claude thread through MCP. */
const createBatch = (fx: ToolkitFixture) =>
  Effect.gen(function* () {
    const call = yield* fx.invoke("create_threads", batchInput);
    expect(call.isError).toBe(false);
    const created = yield* decodeCreateThreadsResult(call.structuredContent).pipe(Effect.orDie);
    const [emptyThread, promptedThread] = created.threads;
    if (emptyThread === undefined || promptedThread === undefined) {
      return yield* Effect.die(new Error("Expected two created threads."));
    }
    const prompted = yield* fx.waitFor(
      promptedThread.threadId,
      (projection) =>
        projection.runs.some(
          (run) => run.id === promptedThread.runId && run.status === "completed",
        ),
      "prompted-thread-completed",
    );
    return { created, emptyThread, promptedThread, prompted };
  });

const createEmptyThread = (fx: ToolkitFixture, title: string, clientRequestId: string) =>
  fx.invoke("create_threads", { clientRequestId, threads: [{ title }] }).pipe(
    Effect.flatMap((call) => decodeCreateThreadsResult(call.structuredContent)),
    Effect.orDie,
    Effect.map((result) => result.threads[0]!),
  );

const createdItems = (
  projection: OrchestrationV2ThreadProjection,
  threadIds: ReadonlySet<string>,
) =>
  projection.visibleTurnItems.filter(
    (row) => row.item.type === "thread_created" && threadIds.has(row.item.targetThreadId),
  );

describe("orchestrator MCP thread operations", () => {
  it.live(
    "defers settle while the caller runs, persists pin and unpin, and refuses queue edits of an active run",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const parentRun = yield* fx.startParent;
          const settle = yield* fx.invoke("scient_thread_organize", { action: "settle" });
          expect(settle.isError).toBe(false);
          expect(settle.structuredContent).toEqual({ settlesWhenTurnEnds: true });
          const afterSettle = yield* fx.projection(parentThreadId);
          expect(afterSettle.thread.settledOverride).not.toBe("settled");
          expect(afterSettle.runs.find((run) => run.id === parentRun.id)?.status).toBe("running");

          const pinned = yield* fx.invoke("scient_thread_organize", { action: "pin" });
          expect(pinned.isError).toBe(false);
          expect(pinned.structuredContent).toHaveProperty("sequence");
          expect((yield* fx.orchestrator.getThreadShell(parentThreadId))?.pinnedAt).not.toBeNull();
          yield* fx.invoke("scient_thread_organize", { action: "unpin" });
          expect((yield* fx.orchestrator.getThreadShell(parentThreadId))?.pinnedAt).toBeNull();

          for (const action of ["edit", "cancel"]) {
            const refused = yield* fx.invoke("scient_queue", {
              action,
              queuedRunId: parentRun.id,
              ...(action === "edit" ? { text: "Keep the active turn." } : {}),
            });
            expect(declaredFailure(refused)).toEqual({
              _tag: "OrchestratorMcpFailure",
              code: "orchestration_error",
              message: `Run ${parentRun.id} is not queued.`,
            });
          }
          const afterRefusals = yield* fx.projection(parentThreadId);
          expect(afterRefusals.runs).toEqual(afterSettle.runs);
          expect(afterRefusals.messages).toEqual(afterSettle.messages);
        }),
      ),
  );

  it.live(
    "creates an empty and a prompted thread with agent provenance and replays the same batch",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const { created, emptyThread, promptedThread, prompted } = yield* createBatch(fx);
          expect(emptyThread).toMatchObject({
            status: "idle",
            createdBy: "agent",
            creationSource: "mcp",
            providerInstanceId: codexInstanceId,
            model: codexModel,
          });
          expect(promptedThread).toMatchObject({
            createdBy: "agent",
            creationSource: "mcp",
            providerInstanceId: claudeInstanceId,
            model: claudeModel,
          });
          expect(prompted.messages[0]).toMatchObject({ senderThreadId: parentThreadId });
          expect(prompted.turnItems.find((item) => item.type === "user_message")).toMatchObject({
            senderThreadId: parentThreadId,
          });
          expect(prompted.thread.lineage.parentThreadId).toBeNull();
          expect(
            prompted.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
          ).toEqual([createdThreadPrompt]);
          const empty = yield* fx.projection(emptyThread.threadId);
          expect(empty.thread.lineage).toEqual({
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: emptyThread.threadId,
          });
          expect(empty.thread).toMatchObject({ createdBy: "agent", creationSource: "mcp" });
          expect(empty.thread.forkedFrom).toBeNull();
          expect(empty.runs).toEqual([]);

          const createdIds = new Set(created.threads.map((thread) => thread.threadId));
          expect(
            createdItems(yield* fx.projection(parentThreadId), createdIds).map(({ item }) =>
              item.type === "thread_created"
                ? {
                    targetThreadId: item.targetThreadId,
                    targetRunId: item.targetRunId,
                    title: item.title,
                    providerInstanceId: item.targetProviderInstanceId,
                    model: item.targetModel,
                  }
                : undefined,
            ),
          ).toEqual([
            {
              targetThreadId: emptyThread.threadId,
              targetRunId: null,
              title: emptyThread.title,
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            {
              targetThreadId: promptedThread.threadId,
              targetRunId: promptedThread.runId,
              title: promptedThread.title,
              providerInstanceId: claudeInstanceId,
              model: claudeModel,
            },
          ]);

          const promptRead = yield* fx
            .invoke("scient_thread_inspect", {
              threadId: promptedThread.threadId,
              // An agent's cursorless read starts at the newest item; page from the oldest.
              afterPosition: -1,
              limit: 1,
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadReadResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(promptRead.thread).toMatchObject({
            status: "completed",
            createdBy: "agent",
            creationSource: "mcp",
          });
          expect(promptRead.items).toMatchObject([
            { type: "user_message", createdBy: "agent", creationSource: "mcp" },
          ]);
          const resultRead = yield* fx
            .invoke("scient_thread_inspect", {
              threadId: promptedThread.threadId,
              afterPosition: promptRead.nextPosition,
              limit: 1,
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadReadResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(resultRead.items).toMatchObject([
            { type: "assistant_message", text: `Claude completed: ${createdThreadPrompt}` },
          ]);

          const repeated = yield* fx.invoke("create_threads", batchInput).pipe(
            Effect.flatMap((call) => decodeCreateThreadsResult(call.structuredContent)),
            Effect.orDie,
          );
          expect(repeated.threads.map((thread) => thread.threadId)).toEqual(
            created.threads.map((thread) => thread.threadId),
          );
          expect(createdItems(yield* fx.projection(parentThreadId), createdIds)).toHaveLength(2);
        }),
      ),
  );

  it.live(
    "replays an accepted batch after its providers are disabled but admits no new prompt",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const { created, emptyThread, promptedThread } = yield* createBatch(fx);
          // A committed creation or prompt keeps its receipt after the catalog changes.
          // Observe the actual persisted command IDs rather than reproducing MCP ID logic.
          const settings = yield* ServerSettings.ServerSettingsService;
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const receiptFor = (
            threadId: ThreadId,
            eventType: "thread.created" | "run.created",
            commandType: "thread.create" | "message.dispatch",
          ) =>
            Effect.gen(function* () {
              const stored = Option.getOrThrow(
                yield* fx.orchestrator
                  .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType })
                  .pipe(Stream.runHead, Effect.timeout("10 seconds")),
              );
              if (stored.commandId === null) {
                return yield* Effect.die(new Error("Expected a persisted command identity."));
              }
              const receipt = Option.getOrThrow(yield* receipts.getByCommandId(stored.commandId));
              expect(receipt).toMatchObject({ threadId, commandType, status: "accepted" });
              return receipt;
            });
          const accepted = [
            yield* receiptFor(emptyThread.threadId, "thread.created", "thread.create"),
            yield* receiptFor(promptedThread.threadId, "thread.created", "thread.create"),
            // A new thread's creation carries its first message, so the same command starts the run.
            yield* receiptFor(promptedThread.threadId, "run.created", "thread.create"),
          ];
          const threadIds = [emptyThread.threadId, promptedThread.threadId];
          const before = yield* Effect.forEach(threadIds, (threadId) =>
            Effect.all({
              projection: fx.projection(threadId),
              sequence: fx.orchestrator.getThreadEventSequence(threadId),
            }),
          );
          const turnsOf = (turns: ReadonlyArray<{ readonly threadId: ThreadId }>) =>
            turns.filter((turn) => threadIds.includes(turn.threadId));
          const turnsBefore = turnsOf(yield* Ref.get(fx.capturedTurns));

          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: {
                ...current.projectSettingsOverrides[projectId],
                providerInstances: {
                  ...current.projectSettingsOverrides[projectId]?.providerInstances,
                  [codexInstanceId]: { enabled: false },
                  [claudeInstanceId]: { enabled: false },
                },
              },
            },
          });
          yield* Ref.set(
            fx.providerCatalog,
            fx.originalCatalog.map((provider) =>
              provider.instanceId === codexInstanceId || provider.instanceId === claudeInstanceId
                ? { ...provider, enabled: false }
                : provider,
            ),
          );
          const management = yield* ThreadManagementService.ThreadManagementService;
          for (const instanceId of [codexInstanceId, claudeInstanceId]) {
            expect(
              yield* management.isProviderInstanceEnabledForProject({ projectId, instanceId }),
            ).toBe(false);
          }

          const replayed = yield* fx.invoke("create_threads", batchInput).pipe(
            Effect.flatMap((call) => decodeCreateThreadsResult(call.structuredContent)),
            Effect.orDie,
          );
          expect(replayed.threads.map((thread) => thread.threadId)).toEqual(threadIds);
          expect(replayed.threads[1]?.runId).toBe(promptedThread.runId);
          // The first entry has an accepted creation but no prompt receipt.
          // Adding its first prompt cannot borrow the creation's admission.
          const partialReplay = yield* fx.invoke("create_threads", {
            ...batchInput,
            threads: [
              { ...batchInput.threads[0]!, prompt: "Fresh prompt after provider disable." },
              batchInput.threads[1]!,
            ],
          });
          expect(declaredFailure(partialReplay)).toMatchObject({
            code: "invalid_request",
            message: expect.stringContaining("disabled"),
          });
          const fresh = yield* fx.invoke("create_threads", {
            clientRequestId: "create-after-catalog-disable",
            threads: [{ target: { driverKind: "claudeAgent" } }],
          });
          expect(declaredFailure(fresh)).toMatchObject({ code: "provider_unavailable" });

          for (const receipt of accepted) {
            expect(Option.getOrThrow(yield* receipts.getByCommandId(receipt.commandId))).toEqual(
              receipt,
            );
          }
          for (const [index, threadId] of threadIds.entries()) {
            const after = yield* fx.projection(threadId);
            expect(after.messages).toEqual(before[index]!.projection.messages);
            expect(after.runs).toEqual(before[index]!.projection.runs);
            expect(yield* fx.orchestrator.getThreadEventSequence(threadId)).toBe(
              before[index]!.sequence,
            );
          }
          expect(turnsOf(yield* Ref.get(fx.capturedTurns))).toEqual(turnsBefore);
          expect(
            createdItems(
              yield* fx.projection(parentThreadId),
              new Set(created.threads.map((thread) => thread.threadId)),
            ),
          ).toHaveLength(2);
        }),
      ),
  );

  it.live(
    "renames the default and an explicit thread with replay protection and regenerates a title",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const target = yield* createEmptyThread(fx, "Inherited empty thread", "rename-target");
          const defaultRenamed = yield* fx
            .invoke("scient_thread_update", {
              action: "rename",
              title: "MCP parent metadata",
              clientRequestId: "metadata-default-thread-1",
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadUpdateResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(defaultRenamed).toMatchObject({
            threadId: parentThreadId,
            action: "rename",
            title: "MCP parent metadata",
          });
          expect((yield* fx.orchestrator.getThreadShell(parentThreadId))?.title).toBe(
            "MCP parent metadata",
          );

          const rename = {
            threadId: target.threadId,
            action: "rename",
            title: "Metadata-managed thread",
            clientRequestId: "metadata-rename-1",
          };
          const renamed = yield* fx.invoke("scient_thread_update", rename).pipe(
            Effect.flatMap((call) => decodeThreadUpdateResult(call.structuredContent)),
            Effect.orDie,
          );
          expect(renamed).toMatchObject({
            threadId: target.threadId,
            action: "rename",
            title: "Metadata-managed thread",
            linkedPullRequest: null,
          });
          const sequenceAfterRename = yield* fx.orchestrator.getThreadEventSequence(
            target.threadId,
          );
          const repeated = yield* fx.invoke("scient_thread_update", rename).pipe(
            Effect.flatMap((call) => decodeThreadUpdateResult(call.structuredContent)),
            Effect.orDie,
          );
          expect(repeated.commandId).toBe(renamed.commandId);
          expect(repeated.sequence).toBe(renamed.sequence);
          expect(yield* fx.orchestrator.getThreadEventSequence(target.threadId)).toBe(
            sequenceAfterRename,
          );

          const regenerating = yield* fx
            .invoke("scient_thread_update", {
              threadId: target.threadId,
              action: "regenerate_title",
              clientRequestId: "metadata-regenerate-title-1",
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadUpdateResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(regenerating).toMatchObject({
            threadId: target.threadId,
            action: "regenerate_title",
            titleRegeneration: { requestId: regenerating.commandId },
          });
        }),
      ),
  );

  it.live("reads and lists metadata, other-repository pull requests, settlement and snooze", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        yield* fx.startParent;
        const target = yield* createEmptyThread(fx, "Metadata-managed thread", "metadata-target");
        const read = () =>
          fx.invoke("scient_thread_inspect", { threadId: target.threadId }).pipe(
            Effect.flatMap((call) => decodeThreadReadResult(call.structuredContent)),
            Effect.orDie,
            Effect.map((result) => result.thread),
          );
        const list = (args: Record<string, unknown>) =>
          fx.invoke("scient_thread_list", { limit: 100, ...args }).pipe(
            Effect.flatMap((call) => decodeThreadListResult(call.structuredContent)),
            Effect.orDie,
            Effect.map((result) => result.threads),
          );
        const listed = (threads: Effect.Success<ReturnType<typeof list>>, threadId: ThreadId) =>
          threads.find((thread) => thread.threadId === threadId);
        const ids = (suffix: string) => ({
          commandId: CommandId.make(`command:mcp-metadata:${suffix}`),
          threadId: target.threadId,
        });

        const linkedPullRequest = {
          projectId,
          repository: "pingdotgg/t3code",
          number: 8689,
          url: "https://github.com/pingdotgg/t3code/pull/8689",
        };
        yield* fx.orchestrator.dispatch({
          ...ids("link"),
          type: "thread.metadata.update",
          linkedPullRequest,
        });
        const linkedRead = yield* read();
        expect(linkedRead).toMatchObject({
          title: "Metadata-managed thread",
          linkedPullRequest,
          settled: false,
          settledAt: null,
          snoozed: false,
          snoozedUntil: null,
        });
        expect(listed(yield* list({}), target.threadId)).toMatchObject({
          title: "Metadata-managed thread",
          linkedPullRequest,
          settled: false,
          settledAt: null,
        });

        yield* fx.orchestrator.dispatch({
          ...ids("settle"),
          type: "thread.settle",
          settledAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        });
        const settled = { settled: true, settledAt: "2026-01-01T00:00:00.000Z" };
        expect(yield* read()).toMatchObject(settled);
        const settledList = yield* list({ settled: true });
        expect(settledList.map((thread) => thread.threadId)).toEqual([target.threadId]);
        expect(settledList[0]).toMatchObject(settled);
        expect(listed(yield* list({ settled: false }), target.threadId)).toBeUndefined();
        yield* fx.orchestrator.dispatch({
          ...ids("unsettle"),
          type: "thread.unsettle",
          reason: "user",
        });

        yield* fx.orchestrator.dispatch({
          ...ids("snooze"),
          type: "thread.snooze",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        });
        const snoozed = { snoozed: true, snoozedUntil: "2099-01-01T00:00:00.000Z" };
        const snoozedList = yield* list({ snoozed: true });
        expect(snoozedList.map((thread) => thread.threadId)).toEqual([target.threadId]);
        expect(snoozedList[0]).toMatchObject(snoozed);
        expect(yield* read()).toMatchObject(snoozed);
        yield* fx.orchestrator.dispatch({
          ...ids("unsnooze"),
          type: "thread.unsnooze",
          reason: "user",
        });
        yield* fx.orchestrator.dispatch({
          ...ids("unlink"),
          type: "thread.metadata.update",
          linkedPullRequest: null,
        });

        // Links added through thread.pull-request.link leave linkedPullRequest unchanged.
        for (const [suffix, number, source] of [
          ["link-other-repository", 42, "agent"],
          ["link-dismissed", 43, "stack-dismissed"],
        ] as const) {
          yield* fx.orchestrator.dispatch({
            ...ids(suffix),
            type: "thread.pull-request.link",
            host: "github.com",
            repository: "octo/other-repo",
            number,
            url: `https://github.com/octo/other-repo/pull/${number}`,
            source,
          });
        }
        const otherRepositoryLink = {
          host: "github.com",
          repository: "octo/other-repo",
          number: 42,
          url: "https://github.com/octo/other-repo/pull/42",
          source: "agent",
          state: null,
        };
        expect(yield* read()).toMatchObject({
          linkedPullRequest: null,
          pullRequests: [otherRepositoryLink],
        });
        const finalList = yield* list({});
        expect(listed(finalList, target.threadId)).toMatchObject({
          linkedPullRequest: null,
          pullRequests: [otherRepositoryLink],
        });
        expect(listed(finalList, parentThreadId)).toMatchObject({ pullRequests: [] });
      }),
    ),
  );

  it.live(
    "keeps an inherited prompt's agent provenance in a fork after its source is rewritten",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const { promptedThread, prompted } = yield* createBatch(fx);
          const forkedThreadId = ThreadId.make("thread:mcp-orchestrator-inherited-read");
          yield* fx.orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-orchestrator-inherited-read"),
            sourceThreadId: promptedThread.threadId,
            targetThreadId: forkedThreadId,
            sourcePoint: { type: "latest_stable" },
            title: "Inherited read thread",
          });
          const forked = yield* fx.projection(forkedThreadId);
          expect(forked.messages.map((message) => message.text)).toEqual(
            prompted.messages.map((message) => message.text),
          );
          expect(forked.thread.forkedFrom).toBeNull();
          expect(forked.thread.lineage.parentThreadId).toBe(promptedThread.threadId);
          expect(
            forked.visibleTurnItems.some(
              (row) =>
                row.visibility === "inherited" &&
                row.sourceThreadId === promptedThread.threadId &&
                row.item.inheritedFrom?.threadId === promptedThread.threadId &&
                row.item.type === "user_message",
            ),
          ).toBe(true);
          const inheritedPrompt = () =>
            fx.invoke("scient_thread_inspect", { threadId: forkedThreadId }).pipe(
              Effect.flatMap((call) => decodeThreadReadResult(call.structuredContent)),
              Effect.orDie,
              Effect.map((read) => read.items.find((item) => item.text === createdThreadPrompt)),
            );
          const agentProvenance = {
            sourceThreadId: promptedThread.threadId,
            createdBy: "agent",
            creationSource: "mcp",
          };
          expect(yield* inheritedPrompt()).toMatchObject(agentProvenance);
          // Rewriting the original's provenance after the fork leaves the fork's
          // report as the fork shows it.
          const shownPrompt = prompted.messages.find(
            (message) => message.text === createdThreadPrompt,
          )!;
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("event:mcp-orchestrator-inherited-provenance"),
                type: "message.updated",
                threadId: promptedThread.threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...shownPrompt, createdBy: "user", creationSource: "web" },
              },
            ],
          });
          expect(yield* inheritedPrompt()).toMatchObject(agentProvenance);
        }),
      ),
  );

  it.live(
    "sends to, waits on, steers and interrupts an ordinary thread's run and replays a repeated send",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const target = yield* createEmptyThread(fx, "Ordinary loop thread", "ordinary-target");
          const ordinaryLoopPrompt = "Run an ordinary thread loop iteration.";
          const send = {
            threadId: target.threadId,
            message: ordinaryLoopPrompt,
            clientRequestId: "ordinary-loop-send-1",
          };
          const sent = yield* fx.invoke("scient_thread_send", send).pipe(
            Effect.flatMap((call) => decodeThreadSendResult(call.structuredContent)),
            Effect.orDie,
          );
          expect(sent.delivery).toBe("started");
          const expectSentByParent = (threadId: ThreadId, messageId: string) =>
            Effect.gen(function* () {
              const source = yield* fx.projection(threadId);
              expect(source.messages.find((message) => message.id === messageId)).toMatchObject({
                senderThreadId: parentThreadId,
              });
              expect(
                source.turnItems.find(
                  (item) => item.type === "user_message" && item.messageId === messageId,
                ),
              ).toMatchObject({ senderThreadId: parentThreadId });
            });
          yield* expectSentByParent(target.threadId, sent.messageId);
          const wait = (threadId: ThreadId, runId: string, timeoutMs: number) =>
            fx.invoke("scient_thread_wait", { threadId, runId, timeoutMs }).pipe(
              Effect.flatMap((call) => decodeThreadWaitResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(yield* wait(target.threadId, sent.runId, 10_000)).toMatchObject({
            runId: sent.runId,
            status: "completed",
            timedOut: false,
          });
          const repeated = yield* fx.invoke("scient_thread_send", send).pipe(
            Effect.flatMap((call) => decodeThreadSendResult(call.structuredContent)),
            Effect.orDie,
          );
          expect(repeated.runId).toBe(sent.runId);
          expect((yield* fx.projection(target.threadId)).runs).toHaveLength(1);

          const active = (yield* fx
            .invoke("create_threads", {
              threads: [{ prompt: cancellationPrompt, title: "Managed active thread" }],
              clientRequestId: "managed-active-thread-1",
            })
            .pipe(
              Effect.flatMap((call) => decodeCreateThreadsResult(call.structuredContent)),
              Effect.orDie,
            )).threads[0]!;
          expect(
            createdItems(yield* fx.projection(parentThreadId), new Set([active.threadId]))[0]?.item,
          ).toMatchObject({
            type: "thread_created",
            title: "Managed active thread",
            targetThreadId: active.threadId,
            targetRunId: active.runId,
            targetProviderInstanceId: codexInstanceId,
            targetModel: codexModel,
          });
          const activeRun = (yield* fx.waitFor(
            active.threadId,
            (projection) =>
              projection.runs.some((run) => run.status === "running") &&
              projection.providerTurns.some((turn) => turn.status === "running"),
            "managed-active-running",
          )).runs[0]!;
          expect(yield* wait(active.threadId, activeRun.id, 1)).toMatchObject({
            runId: activeRun.id,
            status: "running",
            timedOut: true,
          });
          const steered = yield* fx
            .invoke("scient_thread_send", {
              threadId: active.threadId,
              message: "Include the latest parent guidance before finishing.",
              mode: "steer",
              clientRequestId: "managed-active-steer-1",
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadSendResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(steered).toMatchObject({ runId: activeRun.id, delivery: "steered" });
          yield* expectSentByParent(active.threadId, steered.messageId);
          const interrupt = (args: Record<string, unknown>) =>
            fx.invoke("scient_thread_interrupt", { threadId: active.threadId, ...args }).pipe(
              Effect.flatMap((call) => decodeThreadInterruptResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(
            yield* interrupt({
              reason: "The orchestration loop has enough evidence.",
              clientRequestId: "managed-active-interrupt-1",
            }),
          ).toMatchObject({ runId: activeRun.id, status: "interrupt_requested" });
          expect((yield* wait(active.threadId, activeRun.id, 10_000)).status).toBe("interrupted");
          expect((yield* interrupt({ runId: activeRun.id })).status).toBe("interrupted");
        }),
      ),
  );

  it.live(
    "refuses another project's thread without changing it and lists only this project's ordinary threads",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const ordinary = yield* createEmptyThread(fx, "Listed ordinary thread", "listed");
          const delegated = yield* fx.delegateAs(parentThreadId, {
            task: delegatedPrompt,
            target: { providerInstanceId: claudeInstanceId, model: claudeModel },
            mode: "wait",
            timeoutMs: 10_000,
            clientRequestId: "listed-subagent",
          });
          const foreignThreadId = ThreadId.make("thread:mcp-foreign-project");
          yield* fx.orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-foreign-project:create"),
            threadId: foreignThreadId,
            projectId: ProjectId.make("project:mcp-foreign"),
            title: "Foreign project thread",
            modelSelection: { instanceId: codexInstanceId, model: codexModel },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: fx.cwd,
          });
          const foreignSequence = yield* fx.orchestrator.getThreadEventSequence(foreignThreadId);
          for (const [name, args] of [
            ["scient_thread_organize", { action: "pin" }],
            ["scient_thread_inspect", {}],
            ["scient_thread_update", { action: "rename", title: "Should stay foreign" }],
          ] as const) {
            expect(
              declaredFailure(yield* fx.invoke(name, { threadId: foreignThreadId, ...args })),
            ).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "thread_not_found" });
          }
          const foreignShell = yield* fx.orchestrator.getThreadShell(foreignThreadId);
          expect(foreignShell?.pinnedAt).toBeNull();
          expect(foreignShell?.title).toBe("Foreign project thread");
          expect(yield* fx.orchestrator.getThreadEventSequence(foreignThreadId)).toBe(
            foreignSequence,
          );

          const listed = yield* fx
            .invoke("scient_thread_list", { includeSubagents: false, limit: 100 })
            .pipe(
              Effect.flatMap((call) => decodeThreadListResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(listed.projectId).toBe(projectId);
          expect(listed.threads.map((thread) => thread.threadId).toSorted()).toEqual(
            [parentThreadId, ordinary.threadId].toSorted(),
          );
          expect(
            listed.threads.find((thread) => thread.threadId === ordinary.threadId),
          ).toMatchObject({ createdBy: "agent", creationSource: "mcp" });
          expect(
            (yield* fx.projection(delegated.childThreadId)).thread.lineage.relationshipToParent,
          ).toBe("subagent");
        }),
      ),
  );
});
