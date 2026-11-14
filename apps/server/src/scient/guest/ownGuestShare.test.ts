import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GuestShareId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest share lookups"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "own-guest-share" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// regression: 72c0d0fff0 fix(server): a forked conversation no longer takes its source's guest link
it.effect("a guest link opens the thread it was made for, never a copy of it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const createThread = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:own-guest-share"),
        title: "Shared",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const setShare = (
      threadId: ThreadId,
      guestShare: OrchestrationV2AppThread["guestShare"],
      label: string,
    ) =>
      Effect.gen(function* () {
        yield* store.apply({
          id: EventId.make(`own-guest-share:${label}`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...(yield* store.getThread(threadId)), guestShare },
        });
      });
    const sourceId = ThreadId.make("thread:shared-source");
    const forkId = ThreadId.make("thread:copied-fork");
    const shareId = GuestShareId.make("guest-share:source");
    const now = yield* DateTime.now;
    yield* createThread(sourceId);
    yield* setShare(
      sourceId,
      {
        id: shareId,
        host: "guest.example.test",
        createdAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { days: 1 })),
        guestName: null,
        messages: [],
      },
      "source",
    );
    // An older fork was created from a copy of its source, share included.
    const source = yield* store.getThread(sourceId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("own-guest-share:fork-created"),
          type: "thread.created",
          threadId: forkId,
          occurredAt: now,
          payload: {
            ...source,
            id: forkId,
            lineage: {
              parentThreadId: sourceId,
              relationshipToParent: "fork",
              rootThreadId: forkId,
            },
          },
        },
      ],
    });
    assert.equal((yield* store.getThread(forkId)).guestShare?.id, shareId);

    assert.equal(yield* store.findGuestShareThreadId(shareId), sourceId);
    yield* setShare(sourceId, null, "source-closed");
    assert.isNull(yield* store.findGuestShareThreadId(shareId));
  }).pipe(Effect.provide(layerTest)),
);
