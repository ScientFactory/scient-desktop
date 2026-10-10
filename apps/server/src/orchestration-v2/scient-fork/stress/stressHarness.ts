// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { assert } from "@effect/vitest";
import { CommandId, ProviderDriverKind, ThreadId, type MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer as resourceCleanupLayer } from "../../ResourceCleanupService.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { ServerConfig } from "../../../config.ts";
import { ConversationImporter } from "../../../scient/conversationImport/ConversationImporter.ts";
import {
  createNativeProjects,
  nativeImportRuntimeTestLayer,
} from "../../../scient/conversationImport/conversationImport.native-test-harness.ts";
import {
  destination,
  importFixture,
  principal,
  PROVIDER_ID,
  testLease,
  type ImportFixtureOptions,
} from "../../../scient/conversationImport/conversationImport.test-fixtures.ts";
import { CodexProviderCapabilitiesV2 } from "../../Adapters/CodexAdapterV2.ts";
import { EffectOutboxV2 } from "../../EffectOutbox.ts";
import { OrchestratorV2 } from "../../Orchestrator.ts";
import { layerFromAdapters } from "../../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { ConversationForkService } from "../ConversationForkService.ts";

export const inertRegistry = layerFromAdapters([
  {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Stress history tests must not execute a provider"),
  },
]);
export const runtimeOptions = {
  resourceCleanupLayer: resourceCleanupLayer.pipe(
    Layer.provide(Layer.mock(TerminalManager, { close: () => Effect.void })),
  ),
};
const runtime = nativeImportRuntimeTestLayer(inertRegistry, runtimeOptions).pipe(
  Layer.provideMerge(NodeServices.layer),
);

export const seed = Effect.fn("stress.seed")(function* (options: ImportFixtureOptions = {}) {
  yield* createNativeProjects;
  const config = yield* ServerConfig;
  const { lease } = testLease({
    fixture: importFixture(options),
    attemptDirectory: NodePath.join(config.stateDir, "conversation-imports", "stress"),
  });
  const { result } = yield* (yield* ConversationImporter).importConversation(lease, {
    destination: destination(),
    principal: principal(),
  });
  return yield* (yield* ProjectionStoreV2).getThreadProjection(result.threadId);
});

export const fork = Effect.fn("stress.fork")(function* (
  source: ThreadId,
  name: string,
  answer?: MessageId,
) {
  const store = yield* ProjectionStoreV2;
  const projection = yield* store.getThreadProjection(source);
  const boundary = answer ?? projection.messages.findLast((m) => m.role === "assistant")?.id;
  assert.ok(boundary);
  const newThreadId = ThreadId.make(name);
  const receipt = yield* (yield* ConversationForkService).dispatch({
    type: "thread.fork",
    commandId: CommandId.make(name),
    originThreadId: source,
    newThreadId,
    sourceAssistantMessageId: boundary,
    workspaceMode: "local",
  });
  return { receipt, projection: yield* store.getThreadProjection(newThreadId) };
});

export const remove = Effect.fn("stress.remove")(function* (threadId: ThreadId) {
  const commandId = CommandId.make(`delete-${threadId}`);
  const outbox = yield* EffectOutboxV2;
  const completion = yield* Stream.toPull(
    Stream.merge(yield* outbox.subscribeCompletions, Stream.tick("10 millis")),
  );
  yield* (yield* OrchestratorV2).dispatch({ type: "thread.delete", commandId, threadId });
  while (true) {
    const jobs = yield* outbox.listByCommandId(commandId);
    if (jobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.status))) {
      assert.isTrue(jobs.every((job) => job.status === "succeeded"));
      return jobs;
    }
    yield* completion;
  }
});

export const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect.pipe(Effect.provide(runtime), Effect.timeout("120 seconds")));
