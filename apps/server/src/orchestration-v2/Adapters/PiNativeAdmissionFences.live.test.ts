// @effect-diagnostics nodeBuiltinImport:off
import { ProviderSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/continuationRequests";
import { makePiAdapterV2 } from "@t3tools/provider-pi/testing";
import { makePiRpcConnection } from "@t3tools/provider-pi/testing";
import { binary, fixture, layer, serve, json, collect, ensure } from "./PiNativeTestHarness.ts";

const armExtension = (h: Effect.Success<ReturnType<typeof fixture>>) =>
  h.fs.makeDirectory(`${h.profile}/extensions`).pipe(
    Effect.andThen(
      h.fs.writeFileString(
        `${h.profile}/extensions/native-work.ts`,
        `
import fs from "node:fs/promises";
const wait = async path => { while (true) { try { await fs.access(path); return; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); } };
export default function(pi) {
 pi.registerCommand("synthetic-arm", { description: "Synthetic native work", handler: async (_args, ctx) => {
   void (async () => {
     await wait(${json(`${h.root}/wake`)});
     pi.sendMessage({ customType: "native-test", content: "Finish the native task.", display: true }, { triggerTurn: true });
     await wait(${json(`${h.root}/fence`)});
     ctx.ui.notify("Native fence receipt", "info");
   })();
 }});
}`,
      ),
    ),
  );

it.layer(layer, { excludeTestServices: true })("actual Pi native admission fences", (it) => {
  it.effect.skipIf(!binary)(
    "keeps actual native work in the owned turn when a stale outside settlement snapshot returns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture("outside-settlement");
          yield* armExtension(h);
          const statsEntered = yield* Deferred.make<void>();
          const releaseStats = yield* Deferred.make<void>();
          const staleStateEntered = yield* Deferred.make<void>();
          const releaseStaleState = yield* Deferred.make<void>();
          const finishModel = Promise.withResolvers<void>();
          yield* Effect.addFinalizer(() => Effect.sync(() => finishModel.resolve()));
          let requests = 0;
          const base = yield* serve(async (_request, response) => {
            requests++;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              `data: ${json({ id: "outside", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: "Native work still running." }, finish_reason: null }] })}\n\n`,
            );
            await finishModel.promise;
            response.end(
              `data: ${json({ id: "outside", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
            );
          });
          yield* h.models(`${base}/v1`);
          let heldStats = false;
          let heldState = false;
          const adapter = yield* makePiAdapterV2({
            ...h.adapterOptions,
            makeConnection: (input) =>
              makePiRpcConnection(input).pipe(
                Effect.map((connection) => ({
                  ...connection,
                  request: (record, timeout) =>
                    Effect.gen(function* () {
                      const data = yield* connection.request(record, timeout);
                      if (record.type === "get_session_stats" && !heldStats) {
                        heldStats = true;
                        yield* Deferred.succeed(statsEntered, undefined);
                        yield* Deferred.await(releaseStats);
                      } else if (record.type === "get_state" && heldStats && !heldState) {
                        heldState = true;
                        assert.deepInclude(data, { isStreaming: false });
                        yield* Deferred.succeed(staleStateEntered, undefined);
                        yield* Deferred.await(releaseStaleState);
                      }
                      return data;
                    }),
                })),
              ),
          });
          const runtime = yield* adapter.openSession({
            threadId: h.threadId,
            providerSessionId: ProviderSessionId.make(h.threadId),
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          const thread = yield* ensure(h, runtime);
          const c = yield* collect(runtime);
          yield* h.send(runtime, thread, 1, "/synthetic-arm");
          yield* Deferred.await(statsEntered).pipe(Effect.timeout("10 seconds"));
          assert.equal(requests, 0);
          yield* Deferred.succeed(releaseStats, undefined);
          yield* Deferred.await(staleStateEntered).pipe(Effect.timeout("10 seconds"));
          yield* h.fs.writeFileString(`${h.root}/wake`, "start");
          yield* c
            .take(
              (e) =>
                e.type === "message.updated" && e.message.text === "Native work still running.",
            )
            .pipe(Effect.timeout("10 seconds"));
          assert.lengthOf(
            c.events.filter((e) => e.type === "turn.terminal"),
            0,
          );
          yield* Deferred.succeed(releaseStaleState, undefined);
          // A subsequent native UI receipt drains the pump after the old snapshot.
          yield* h.fs.writeFileString(`${h.root}/fence`, "notify");
          yield* c
            .take(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "dynamic_tool" &&
                e.turnItem.toolName === "notify",
            )
            .pipe(Effect.timeout("10 seconds"));
          assert.lengthOf(
            c.events.filter((e) => e.type === "turn.terminal"),
            0,
          );
          finishModel.resolve();
          const terminal = yield* c
            .take((e) => e.type === "turn.terminal")
            .pipe(Effect.timeout("10 seconds"));
          assert.equal(
            terminal.type === "turn.terminal" ? terminal.status : undefined,
            "completed",
          );
          assert.lengthOf(
            c.events.filter((e) => e.type === "turn.terminal"),
            1,
          );
          assert.equal(requests, 1);
          assert.equal(terminal.type === "turn.terminal" ? terminal.runOrdinal : undefined, 1);
          const ownedTurns = c.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.ordinal === 1
              ? [event.providerTurn]
              : [],
          );
          assert.isNotEmpty(ownedTurns);
          assert.isTrue(
            ownedTurns.every((turn) => turn.nodeId === "pi-real-node-outside-settlement-1"),
          );
          assert.deepEqual(
            [...new Set(ownedTurns.map((turn) => turn.id))],
            [terminal.type === "turn.terminal" ? terminal.providerTurnId : undefined],
          );
          assert.deepEqual(
            [
              ...new Set(
                c.events.flatMap((event) =>
                  event.type === "message.updated" &&
                  event.message.text === "Native work still running."
                    ? [event.message.runId]
                    : [],
                ),
              ),
            ],
            ["pi-real-run-outside-settlement-1"],
          );
          assert.isTrue(
            c.events.some(
              (e) =>
                e.type === "message.updated" &&
                e.message.text === "Native work still running." &&
                e.message.streaming === false,
            ),
          );
        }),
      ),
    30000,
  );

  it.effect.skipIf(!binary)(
    "disposes an actual buffered generation at exact prewire Stop without native acceptance or another prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture("prewire-stop");
          yield* armExtension(h);
          const offered = yield* Deferred.make<ProviderContinuationRequest>();
          const finishModel = Promise.withResolvers<void>();
          yield* Effect.addFinalizer(() => Effect.sync(() => finishModel.resolve()));
          const modelEntered = Promise.withResolvers<void>();
          let models = 0;
          let prompts = 0;
          const base = yield* serve(async (_request, response) => {
            models++;
            modelEntered.resolve();
            response.writeHead(200, { "content-type": "text/event-stream" });
            if (models === 1) await finishModel.promise;
            response.end(
              `data: ${json({ id: "prewire", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: "Next owned answer." }, finish_reason: null }] })}\n\ndata: ${json({ id: "prewire", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
            );
          });
          yield* h.models(`${base}/v1`);
          const adapter = yield* makePiAdapterV2({
            ...h.adapterOptions,
            continuationRequests: {
              offer: (packet) => Deferred.succeed(offered, packet).pipe(Effect.asVoid),
            },
            makeConnection: (input) =>
              makePiRpcConnection(input).pipe(
                Effect.map((connection) => ({
                  ...connection,
                  send: (record) =>
                    Effect.sync(() => {
                      if (record.type === "prompt") prompts++;
                    }).pipe(Effect.andThen(connection.send(record))),
                })),
              ),
          });
          const session = yield* adapter.openSession({
            threadId: h.threadId,
            providerSessionId: ProviderSessionId.make(h.threadId),
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          const thread = yield* ensure(h, session);
          const c = yield* collect(session);
          yield* h.send(session, thread, 1, "/synthetic-arm");
          yield* c.take((e) => e.type === "turn.terminal").pipe(Effect.timeout("10 seconds"));
          yield* h.fs.writeFileString(`${h.root}/wake`, "start");
          const packet = yield* Deferred.await(offered).pipe(Effect.timeout("10 seconds"));
          const captured = packet.initiated!;
          yield* Effect.promise(() => modelEntered.promise).pipe(Effect.timeout("10 seconds"));
          let checks = 0;
          const stopped = yield* h
            .send(
              {
                ...session,
                startTurn: (input) =>
                  session.startTurn({
                    ...input,
                    modelSelection: captured.modelSelection,
                    runtimePolicy: captured.runtimePolicy,
                    message: {
                      ...input.message,
                      createdBy: "agent",
                      creationSource: "provider",
                      notification: {
                        source: {
                          kind: "provider_work",
                          workId: captured.workId,
                          providerSessionId: captured.providerSessionId,
                          providerThreadId: packet.providerThreadId,
                          modelSelection: captured.modelSelection,
                          runtimePolicy: captured.runtimePolicy,
                        },
                        outcome: "updated",
                        summary: "Adopt native work",
                      },
                    },
                    shouldStartProviderTurn: () =>
                      Effect.sync(() => {
                        checks++;
                        return false;
                      }),
                  }),
              },
              thread,
              2,
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(stopped));
          assert.equal(checks, 1);
          assert.equal(models, 1);
          assert.equal(prompts, 1);
          assert.isFalse(yield* session.hasPendingBackgroundWork!);
          assert.isTrue(Option.isNone(yield* packet.dispatchIfCurrent!(Effect.succeed("stale"))));
          yield* packet.clearIfCurrent!();
          yield* packet.clearIfCurrent!();
          assert.isFalse(
            c.events.some(
              (e) => e.type === "provider_turn.updated" && e.providerTurn.ordinal === 2,
            ),
          );
          assert.lengthOf(
            c.events.filter((e) => e.type === "turn.terminal"),
            1,
          );
          finishModel.resolve();
          const file = thread.nativeThreadRef?.nativeId;
          if (file == null) return yield* Effect.die("Missing native Pi file after owned arm");
          const replacement = yield* h.open(file);
          const nextThread = yield* ensure(h, replacement);
          const next = yield* collect(replacement);
          yield* h.send(replacement, nextThread, 3, "Fresh owned reuse");
          const terminal = yield* next
            .take((e) => e.type === "turn.terminal")
            .pipe(Effect.timeout("10 seconds"));
          assert.equal(
            terminal.type === "turn.terminal" ? terminal.status : undefined,
            "completed",
          );
          assert.equal(models, 2);
        }),
      ),
    30000,
  );

  it.effect.skipIf(!binary)(
    "cancelling a lock-waiting native send preserves the other live Pi owner and its next turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture("lock-waiting-send");
          let models = 0;
          let opens = 0;
          let prompts = 0;
          const base = yield* serve(async (_request, response) => {
            models++;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              `data: ${json({ id: "lock", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: "Owned native response." }, finish_reason: null }] })}\n\ndata: ${json({ id: "lock", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
            );
          });
          yield* h.models(`${base}/v1`);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let selectionStarted = false;
          let held = false;
          const adapter = yield* makePiAdapterV2({
            ...h.adapterOptions,
            makeConnection: (input) =>
              Effect.sync(() => opens++).pipe(
                Effect.andThen(makePiRpcConnection(input)),
                Effect.map((connection) => ({
                  ...connection,
                  send: (record) =>
                    Effect.sync(() => {
                      if (record.type === "prompt") prompts++;
                    }).pipe(Effect.andThen(connection.send(record))),
                  request: (record, timeout) =>
                    connection.request(record, timeout).pipe(
                      Effect.tap(() => {
                        if (record.type === "set_model") selectionStarted = true;
                        if (record.type !== "get_state" || !selectionStarted || held)
                          return Effect.void;
                        held = true;
                        return Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        );
                      }),
                    ),
                })),
              ),
          });
          const runtime = yield* adapter.openSession({
            threadId: h.threadId,
            providerSessionId: ProviderSessionId.make(h.threadId),
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          const thread = yield* ensure(h, runtime);
          const c = yield* collect(runtime);
          const first = yield* h
            .send(runtime, thread, 1, "First owned send")
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
          const waiting = yield* h
            .send(runtime, thread, 2, "Cancelled lock waiter")
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Fiber.interrupt(waiting);
          const cancelled = yield* Fiber.await(waiting);
          assert.isTrue(Exit.isFailure(cancelled) && Cause.hasInterruptsOnly(cancelled.cause));
          assert.equal(opens, 1);
          assert.equal(prompts, 0);
          assert.notEqual(runtime.providerSession.status, "stopped");
          assert.notEqual(runtime.providerSession.status, "error");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          const terminal = yield* c
            .take((e) => e.type === "turn.terminal")
            .pipe(Effect.timeout("10 seconds"));
          assert.equal(
            terminal.type === "turn.terminal" ? terminal.status : undefined,
            "completed",
          );
          assert.isFalse(
            c.events.some(
              (e) => e.type === "provider_turn.updated" && e.providerTurn.ordinal === 2,
            ),
          );
          yield* h.send(runtime, thread, 3, "Next owned send");
          const next = yield* c
            .take((e) => e.type === "turn.terminal" && e.runOrdinal === 3)
            .pipe(Effect.timeout("10 seconds"));
          assert.equal(next.type === "turn.terminal" ? next.status : undefined, "completed");
          assert.equal(opens, 1);
          assert.equal(prompts, 2);
          assert.equal(models, 2);
        }),
      ),
    30000,
  );
});
