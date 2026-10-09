import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeProviderReplayGate } from "./testkit/ProviderReplayGate.testkit.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./testkit/ReplayTranscriptNdjson.ts";
import { PROPOSED_PLAN_PROMPT } from "./testkit/fixtures/shared.ts";

it.live(
  "freezes the received partial native proposal and retains its first timestamp through later deltas",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("inherited-partial-plan");
        const recorded = yield* readProviderReplayTranscript(
          new URL("./testkit/fixtures/proposed_plan/codex_transcript.ndjson", import.meta.url),
        );
        let deltas = 0;
        const gated = {
          ...recorded,
          entries: recorded.entries.map((entry) =>
            entry.type === "emit_inbound" && entry.label === "item/plan/delta" && ++deltas === 2
              ? { ...entry, label: "remaining-plan-deltas" }
              : entry,
          ),
        };
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(gated, cwd),
        );
        const gate = makeProviderReplayGate(["remaining-plan-deltas"]);
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
        const registry = CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(
          transcript,
          { replayGate: gate },
        );
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          {
            name: "inherited-partial-plan",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
            },
          },
          registry,
          { configureMcp: false, runEffectWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const sink = yield* EventSinkV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const outbox = yield* EffectOutboxV2;
          const forks = yield* ConversationForkService;
          const threadId = ThreadId.make("inherited-partial-plan");
          const forkId = ThreadId.make("inherited-partial-plan-fork");
          const projectId = ProjectId.make("inherited-partial-plan-project");
          const modelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-luna",
          };
          const now = yield* DateTime.now;
          yield* sink.commitProjectCommand({
            commandId: CommandId.make("partial-plan-project"),
            projectId,
            commandType: "project.created",
            acceptedAt: now,
            event: {
              eventId: EventId.make("partial-plan-project"),
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: DateTime.formatIso(now),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              type: "project.created",
              payload: {
                projectId,
                title: "Partial plan",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                scripts: [],
                createdAt: DateTime.formatIso(now),
                updatedAt: DateTime.formatIso(now),
              },
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("partial-plan-thread"),
            threadId,
            projectId,
            title: "Partial plan",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          const waitFor = Effect.fnUntraced(function* (
            predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
          ) {
            const cursor = yield* orchestrator.getThreadEventSequence(threadId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({
                threadId,
                afterSequence: cursor,
              }),
            );
            const initial = yield* orchestrator.getThreadProjection(threadId);
            const found = yield* Stream.concat(
              Stream.succeed(initial),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
              ),
            ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
            assert.ok(Option.isSome(found));
            return found.value;
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("partial-plan-prompt"),
            threadId,
            messageId: MessageId.make("partial-plan-prompt"),
            text: PROPOSED_PLAN_PROMPT,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const starting = yield* worker.drain(12).pipe(Effect.forkScoped);
          assert.isTrue(
            yield* Effect.promise(() => gate.waitForReached("remaining-plan-deltas")).pipe(
              Effect.timeout("15 seconds"),
            ),
          );
          const partial = yield* waitFor((projection) =>
            projection.turnItems.some(
              (item) => item.type === "proposed_plan" && item.markdown.length > 0,
            ),
          );
          const item = partial.turnItems.find((item) => item.type === "proposed_plan");
          assert.ok(item?.type === "proposed_plan");
          assert.isTrue(item.streaming);
          assert.ok(item.startedAt);
          assert.equal(partial.runs[0]?.status, "running");
          const proposal = partial.plans.find((plan) => plan.id === item.planId);
          assert.ok(proposal?.kind === "proposed_plan");
          assert.equal(proposal.markdown, item.markdown);
          const forkCommandId = CommandId.make("partial-plan-fork");
          yield* forks.dispatch({
            type: "thread.fork",
            commandId: forkCommandId,
            originThreadId: threadId,
            newThreadId: forkId,
            sourceRunningTurnId: TurnId.make(partial.runs[0]!.id),
            workspaceMode: "local",
          });
          // A local fork copies only the running plan and is ready at once.
          assert.equal(
            (yield* orchestrator.getThreadProjection(forkId)).thread.conversationFork?.status,
            "ready",
          );
          assert.isFalse(
            (yield* outbox.listByCommandId(forkCommandId)).some(
              (effect) => effect.request.type === "scient-fork.provision",
            ),
          );
          assert.isTrue(gate.hasReached("remaining-plan-deltas"));
          const frozen = yield* orchestrator.getThreadProjection(forkId);
          const copied = frozen.turnItems.find((entry) => entry.type === "proposed_plan");
          assert.ok(copied?.type === "proposed_plan");
          assert.equal(copied.markdown, item.markdown);
          assert.equal(DateTime.formatIso(copied.startedAt!), DateTime.formatIso(item.startedAt));
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "running",
          );
          gate.release("remaining-plan-deltas");
          yield* waitFor(
            (p) =>
              ["waiting", "completed"].includes(p.runs[0]?.status ?? "") &&
              p.providerTurns.some((turn) => turn.status === "completed"),
          );
          yield* Fiber.join(starting);
          yield* worker.drain(12);
          const completed = yield* waitFor(
            (projection) => projection.runs[0]?.status === "completed",
          );
          const finalItem = completed.turnItems.find((entry) => entry.id === item.id);
          assert.ok(finalItem?.type === "proposed_plan");
          assert.isFalse(finalItem.streaming);
          assert.isAbove(finalItem.markdown.length, item.markdown.length);
          assert.isTrue(finalItem.markdown.startsWith(item.markdown));
          assert.equal(
            DateTime.formatIso(finalItem.startedAt!),
            DateTime.formatIso(item.startedAt),
          );
          const frozenAgain = yield* orchestrator.getThreadProjection(forkId);
          const retained = frozenAgain.turnItems.find((entry) => entry.id === copied.id);
          assert.ok(retained?.type === "proposed_plan");
          assert.equal(retained.markdown, item.markdown);
          assert.equal(DateTime.formatIso(retained.startedAt!), DateTime.formatIso(item.startedAt));
        }).pipe(Effect.ensuring(Effect.sync(() => gate.releaseAll())), Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
