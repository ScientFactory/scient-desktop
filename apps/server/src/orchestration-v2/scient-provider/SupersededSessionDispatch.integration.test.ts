import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { EffectOutboxV2 } from "../EffectOutbox.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";

// A failed session with native history is replaced under a new id; its start names the
// refused owner so the session manager retires that exact runtime first.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "superseded-session-dispatch" },
  makeLayer([
    {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Provider execution is not part of this dispatch"),
    },
  ]),
  { runEffectWorker: false },
);

it.effect.each([
  ["error", "immediate"],
  ["ready", "immediate"],
  ["error", "queued"],
  ["error", "deferred"],
  ["ready", "deferred"],
] as const)(
  "names the refused owner only when dispatch replaces a %s session (%s start)",
  ([status, start]) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const outbox = yield* EffectOutboxV2;
      const threadId = ThreadId.make(`superseded-session-dispatch-${status}-${start}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Superseded session",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        createdBy: "user",
        creationSource: "web",
      });
      const send = (
        index: number,
        type: "start_immediately" | "queue_after_active" | "defer_start",
      ) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text: `Message ${index}`,
          attachments: [],
          modelSelection,
          dispatchMode: { type },
        });
      yield* send(0, "start_immediately");
      if (start === "queued") yield* send(1, "queue_after_active");
      const first = yield* orchestrator.getThreadProjection(threadId);
      const failedRun = first.runs[0]!;
      const providerThread = first.providerThreads[0]!;
      const ownerId = providerThread.providerSessionId!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${threadId}:session`),
            type: "provider-session.attached",
            threadId,
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              id: ownerId,
              driver,
              providerInstanceId: instanceId,
              status,
              cwd: process.cwd(),
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: status === "error" ? "Model error." : null,
            },
          },
          {
            id: EventId.make(`${threadId}:native`),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              ...providerThread,
              status: "idle",
              nativeThreadRef: { driver, nativeId: "native-history", strength: "strong" },
              updatedAt: now,
            },
          },
          {
            id: EventId.make(`${threadId}:failed`),
            type: "run.updated",
            threadId,
            runId: failedRun.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...failedRun, status: "failed", startedAt: now, completedAt: now },
          },
        ],
      });
      if (start === "queued")
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        });
      else yield* send(1, start === "deferred" ? "defer_start" : "start_immediately");
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const nextRun = accepted.runs[1]!;
      if (start === "deferred") {
        // The prepared run waits without a start; its release must still name the owner.
        assert.equal(nextRun.status, "preparing");
        assert.isEmpty(
          (yield* outbox.listByCommandId(CommandId.make(`${threadId}:message:1`))).filter(
            (candidate) => candidate.request.type === "provider-turn.start",
          ),
        );
        yield* orchestrator.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`${threadId}:release`),
          threadId,
          runId: nextRun.id,
        });
      }
      const second = yield* orchestrator.getThreadProjection(threadId);
      const startCommandId =
        start === "queued"
          ? CommandId.make(`command:system:start-queued:${nextRun.id}:${nextRun.activeAttemptId}`)
          : CommandId.make(`${threadId}:${start === "deferred" ? "release" : "message:1"}`);
      const nextSessionId = second.providerThreads.find(
        (candidate) => candidate.id === providerThread.id,
      )?.providerSessionId;
      const effect = (yield* outbox.listByCommandId(startCommandId)).find(
        (candidate) => candidate.request.type === "provider-turn.start",
      );
      assert.ok(effect?.request.type === "provider-turn.start");
      assert.equal(effect.request.runId, nextRun.id);
      if (status === "error") {
        assert.notEqual(nextSessionId, ownerId);
        assert.equal(effect.request.supersededProviderSessionId, ownerId);
      } else {
        assert.equal(nextSessionId, ownerId);
        assert.isUndefined(effect.request.supersededProviderSessionId);
      }
    }).pipe(Effect.provide(testLayer)),
);
