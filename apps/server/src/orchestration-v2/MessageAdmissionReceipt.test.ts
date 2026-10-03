import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { dispatchCommandReceipt } from "./ThreadMessageIntake.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "message-admission-receipts" },
  makeLayer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Provider execution is paused for receipt inspection"),
    },
  ]),
  { runEffectWorker: false },
);

it.effect("replays the persisted queued admission after the queued run has completed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const threadId = ThreadId.make("receipt-thread");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("receipt-create"),
      threadId,
      projectId: ProjectId.make("receipt-project"),
      title: "Receipt test",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const first = {
      type: "message.dispatch",
      commandId: CommandId.make("receipt-first"),
      threadId,
      messageId: MessageId.make("receipt-first-message"),
      text: "First",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    } satisfies OrchestrationV2Command;
    const admitted = yield* orchestrator.dispatch(first);
    assert.equal(dispatchCommandReceipt(first, admitted).queued, false);

    const queued = {
      ...first,
      commandId: CommandId.make("receipt-second"),
      messageId: MessageId.make("receipt-second-message"),
      text: "Second",
      dispatchMode: { type: "queue_after_active" },
    } satisfies OrchestrationV2Command;
    const accepted = yield* orchestrator.dispatch(queued);
    assert.deepEqual(dispatchCommandReceipt(queued, accepted), {
      sequence: accepted.sequence,
      queued: true,
      submission: { submissionId: queued.messageId, outcome: "queued" },
    });
    const event = accepted.storedEvents.find(({ event }) => event.type === "run.created")?.event;
    assert.ok(event?.type === "run.created");
    yield* sink.write({
      events: [
        {
          id: EventId.make("receipt-complete-queued"),
          type: "run.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...event.payload, status: "completed", queuePosition: null },
        },
      ],
    });
    const replayed = yield* orchestrator.dispatch(queued);
    assert.deepEqual(
      dispatchCommandReceipt(queued, replayed),
      dispatchCommandReceipt(queued, accepted),
    );
  }).pipe(Effect.provide(testLayer)),
);
