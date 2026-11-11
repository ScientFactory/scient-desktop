import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  CODEX_DRIVER,
  emptyState,
  makeProviderAdapter,
  makeProviderThread,
  makeTestLayer,
  makeThreadCreatedEvent,
  modelSelection,
  runtimePolicy,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect(
  "releases the old native writer after its durable thread is reassigned, without unloading a peer",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const owners = yield* Ref.make(new Map<string, ProviderSessionId>());
      const registry = Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.gen(function* () {
          const delegate = yield* makeProviderAdapter(state);
          return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: () =>
              Effect.succeed({
                ...delegate,
                openSession: Effect.fn("WriterFixture.openSession")(function* (input) {
                  const runtime = yield* delegate.openSession(input);
                  return {
                    ...runtime,
                    resumeThread: Effect.fn("WriterFixture.resumeThread")(function* (request) {
                      const nativeId = request.providerThread.nativeThreadRef?.nativeId;
                      if (nativeId == null) return yield* Effect.die("Missing fixture native id");
                      const owner = (yield* Ref.get(owners)).get(nativeId);
                      if (owner !== undefined && owner !== input.providerSessionId)
                        return yield* new ProviderAdapterProtocolError({
                          driver: CODEX_DRIVER,
                          detail: "Conversation has another native writer.",
                        });
                      yield* Ref.update(owners, (current) =>
                        new Map(current).set(nativeId, input.providerSessionId),
                      );
                      return yield* runtime.resumeThread(request);
                    }),
                    unloadThread: Effect.fn("WriterFixture.unloadThread")(function* (request) {
                      const nativeId = request.providerThread.nativeThreadRef?.nativeId;
                      if (nativeId == null) return yield* Effect.die("Missing fixture native id");
                      yield* Ref.update(owners, (current) => {
                        if (current.get(nativeId) !== input.providerSessionId) return current;
                        const next = new Map(current);
                        next.delete(nativeId);
                        return next;
                      });
                      yield* runtime.unloadThread!(request);
                    }),
                  };
                }),
              }),
            list: () => Effect.succeed([modelSelection.instanceId]),
          });
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("reassigned-writer");
        const peerId = ThreadId.make("unrelated-writer");
        const oldSessionId = ProviderSessionId.make("shared-owner");
        const newSessionId = ProviderSessionId.make("replacement-owner");
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId: oldSessionId,
          now,
        });
        const peer = makeProviderThread({
          idAllocator,
          threadId: peerId,
          providerSessionId: oldSessionId,
          nativeThreadId: "peer-native",
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: peerId, now }),
          ],
        });
        const old = yield* manager.open({
          threadId,
          providerSessionId: oldSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: peerId,
          providerSessionId: oldSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* old.resumeThread({ threadId, providerThread, modelSelection, runtimePolicy });
        yield* old.resumeThread({
          threadId: peerId,
          providerThread: peer,
          modelSelection,
          runtimePolicy,
        });
        const replacement = { ...providerThread, providerSessionId: newSessionId };
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: replacement,
            },
          ],
        });
        yield* manager.detach({ providerSessionId: oldSessionId, threadId });
        const next = yield* manager.open({
          threadId,
          providerSessionId: newSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* next.resumeThread({
          threadId,
          providerThread: replacement,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.detach({ providerSessionId: oldSessionId, threadId });
        assert.deepEqual(
          [...(yield* Ref.get(owners))],
          [
            ["peer-native", oldSessionId],
            ["native-thread", newSessionId],
          ],
        );
        assert.isTrue(Option.isSome(yield* manager.get(oldSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            configureMcp: false,
            adapterRegistryLayer: registry,
          }),
        ),
        Effect.scoped,
      );
    }),
);
