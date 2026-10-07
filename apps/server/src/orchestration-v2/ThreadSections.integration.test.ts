import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadSectionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:sections");
const layer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "native-sections" },
  makeLayer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Section controls must not execute a provider"),
    },
  ]),
  { runEffectWorker: false },
);

const createThread = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("sections:create"),
    threadId,
    projectId: ProjectId.make("project:sections"),
    title: "Sections",
    modelSelection: { instanceId, model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

it.effect("sets and clears native sections without changing activity or lifecycle state", () =>
  Effect.gen(function* () {
    yield* createThread;
    const orchestrator = yield* OrchestratorV2;
    const store = yield* ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("sections:pin"),
      threadId,
      orderKey: "g",
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("sections:settle"),
      threadId,
    });
    const before = yield* store.getThreadProjection(threadId);
    yield* TestClock.adjust("1 hour");
    for (const sectionId of [ThreadSectionId.make("research"), null]) {
      const command = {
        type: "thread.section.set" as const,
        commandId: CommandId.make(`sections:set:${sectionId ?? "none"}`),
        threadId,
        sectionId,
      };
      const receipt = yield* orchestrator.dispatch(command);
      assert.deepEqual(yield* orchestrator.dispatch(command), receipt);
      const projection = yield* store.getThreadProjection(threadId);
      assert.deepEqual(projection.thread, { ...before.thread, sectionId });
      assert.deepEqual(projection.runs, before.runs);
      assert.deepEqual(projection.messages, before.messages);
      assert.equal((yield* store.getThreadShell(threadId))?.sectionId, sectionId);
      assert.equal(
        (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.sectionId,
        sectionId,
      );
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.sectionId, sectionId);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("reads native sections in archived shells and detail projections", () =>
  Effect.gen(function* () {
    yield* createThread;
    const orchestrator = yield* OrchestratorV2;
    const store = yield* ProjectionStoreV2;
    const sectionId = ThreadSectionId.make("archive-research");
    yield* orchestrator.dispatch({
      type: "thread.section.set",
      commandId: CommandId.make("sections:before-archive"),
      threadId,
      sectionId,
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("sections:archive"),
      threadId,
    });
    assert.equal((yield* store.getThreadShell(threadId))?.sectionId, sectionId);
    assert.equal((yield* store.getThreadProjection(threadId)).thread.sectionId, sectionId);
    assert.equal(
      (yield* store.getShellSnapshot({ location: "archive" })).archivedThreads.find(
        (thread) => thread.id === threadId,
      )?.sectionId,
      sectionId,
    );
    assert.isFalse(
      (yield* store.getShellSnapshot()).threads.some((thread) => thread.id === threadId),
    );
  }).pipe(Effect.provide(layer)),
);

for (const state of ["archived", "deleted", "missing"] as const) {
  it.effect(`rejects filing a native ${state} thread without changing its projection`, () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const store = yield* ProjectionStoreV2;
      if (state !== "missing") {
        yield* createThread;
        yield* orchestrator.dispatch({
          type: state === "archived" ? "thread.archive" : "thread.delete",
          commandId: CommandId.make(`sections:${state}`),
          threadId,
        });
      }
      const before = state === "missing" ? null : yield* store.getThreadProjection(threadId);
      const failure = yield* orchestrator
        .dispatch({
          type: "thread.section.set",
          commandId: CommandId.make(`sections:rejected:${state}`),
          threadId,
          sectionId: ThreadSectionId.make("unavailable"),
        })
        .pipe(Effect.flip);
      assert.equal(
        failure._tag,
        state === "missing" ? "OrchestratorProjectionError" : "OrchestratorDispatchError",
      );
      if (before !== null) assert.deepEqual(yield* store.getThreadProjection(threadId), before);
    }).pipe(Effect.provide(layer)),
  );
}
