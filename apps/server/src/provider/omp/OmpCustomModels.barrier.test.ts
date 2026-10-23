import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { OMP_PENDING_CONNECTION_DETAIL } from "./OmpModel.ts";
import { connection, model, secondModel, setup } from "./OmpCustomModels.barrier.testkit.ts";

describe("Oh My Pi custom-model refresh barrier", () => {
  it.effect("M-5 refreshModels waits for the acknowledged generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, extension } = yield* setup({ label: "ack", watch: false });
        const refreshModels = client.refreshModels;
        if (!refreshModels) throw new Error("the bridge does not expose refreshModels");
        const refresh = yield* Effect.forkChild(refreshModels());
        // The extension learns of the new generation from the long-poll.
        const next = yield* Effect.promise(() => extension.wait(extension.applied()));
        expect(next.generation).toBe(extension.applied() + 1);
        yield* TestClock.adjust("30 millis");
        expect(refresh.pollUnsafe()).toBeUndefined();
        yield* Effect.promise(() => extension.refresh());
        expect(Exit.isSuccess(yield* Fiber.await(refresh))).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );

  it.effect("M-5 a stale in-flight refresh does not satisfy a newer target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, extension, changeSettings } = yield* setup({
          label: "stale",
          watch: false,
        });
        yield* changeSettings([{ ...connection, models: [model, secondModel] }]);
        // The extension reads generation 2, but has not acknowledged it yet.
        const stale = yield* Effect.promise(() => extension.load());
        expect(stale.generation).toBe(2);
        const refresh = yield* Effect.forkChild(client.refreshModels!());
        const target = yield* Effect.promise(() => extension.wait(stale.generation));
        expect(target.generation).toBe(stale.generation + 1);
        yield* TestClock.adjust("30 millis");
        extension.register(stale);
        expect(yield* Effect.promise(() => extension.acknowledge(stale.generation))).toBe(204);
        yield* TestClock.adjust("30 millis");
        expect(refresh.pollUnsafe()).toBeUndefined();
        const fresh = yield* Effect.promise(() => extension.load());
        expect(fresh.generation).toBe(3);
        extension.register(fresh);
        yield* Effect.promise(() => extension.acknowledge(fresh.generation));
        expect(Exit.isSuccess(yield* Fiber.await(refresh))).toBe(true);
        // A generation Scient never published cannot be acknowledged ahead.
        expect(yield* Effect.promise(() => extension.acknowledge(99))).toBe(204);
        const late = yield* Effect.forkChild(client.refreshModels!());
        const laterTarget = yield* Effect.promise(() => extension.wait(fresh.generation));
        expect(laterTarget.generation).toBe(fresh.generation + 1);
        yield* TestClock.adjust("30 millis");
        expect(late.pollUnsafe()).toBeUndefined();
        yield* Effect.promise(() => extension.refresh());
        expect(Exit.isSuccess(yield* Fiber.await(late))).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );

  it.effect("M-5 timeout, failed registration, and retirement return typed errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, extension, changeSettings } = yield* setup({
          label: "typed",
          watch: false,
          timing: { refreshTimeoutMs: 150 },
        });
        const timingOut = yield* Effect.forkChild(client.refreshModels!().pipe(Effect.flip));
        const timedOutTarget = yield* Effect.promise(() => extension.wait(extension.applied()));
        expect(timedOutTarget).toEqual({ status: 200, generation: 2 });
        yield* TestClock.adjust("150 millis");
        const timeout = yield* Fiber.join(timingOut);
        expect(timeout).toMatchObject({ _tag: "OmpModelRefreshError", reason: "timeout" });
        expect(timeout.message).toMatch(/within 1 seconds/u);

        const failing = yield* Effect.forkChild(client.refreshModels!());
        yield* Effect.promise(() => extension.wait(2));
        const body = yield* Effect.promise(() => extension.load());
        yield* Effect.promise(() => extension.acknowledge(body.generation, "invalid model schema"));
        const failed = yield* Fiber.join(failing).pipe(Effect.flip);
        expect(failed).toMatchObject({ _tag: "OmpModelRefreshError", reason: "failed" });
        expect(failed.message).toContain("invalid model schema");

        const retiring = yield* Effect.forkChild(client.refreshModels!());
        yield* Effect.promise(() => extension.wait(body.generation));
        // A removed model revokes the bridge: the process must be replaced.
        yield* changeSettings([{ ...connection, models: [] }]);
        const retired = yield* Fiber.join(retiring).pipe(Effect.flip);
        expect(retired).toMatchObject({ _tag: "OmpModelRefreshError", reason: "retired" });
        expect(yield* client.getState().pipe(Effect.flip)).toMatchObject({
          message: expect.stringContaining("retired"),
        });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );

  it.effect("a newly added model is selectable without an explicit refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, changeSettings } = yield* setup({ label: "no-refresh", watch: true });
        yield* changeSettings([{ ...connection, models: [model, secondModel] }]);
        // No refreshModels and no refresh command: the barrier alone suffices.
        expect((yield* client.getModels()).models).toContainEqual(
          expect.objectContaining({ provider: "scient_local", id: "second-model" }),
        );
        yield* client.setModel("scient_local", "second-model");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );

  it.effect("M-7 guarded RPCs never read the secret store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, state, changeSettings } = yield* setup({
          label: "reads",
          watch: true,
        });
        expect(state.resolutions).toBe(1);
        for (let index = 0; index < 5; index += 1) {
          yield* client.getState();
          yield* client.getModels();
          yield* client.getCommands();
          yield* client.prompt({ message: "hello" });
          yield* client.setThinkingLevel("low");
          yield* client.setModel("scient_local", "local-model");
        }
        expect(state.resolutions).toBe(1);
        // A settings change is read once; a repeated revision is not re-read.
        yield* changeSettings([connection], 7);
        expect(state.resolutions).toBe(2);
        yield* changeSettings([connection], 7);
        yield* client.getModels();
        expect(state.resolutions).toBe(2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );

  it.effect("a keyed connection added mid-conversation asks for a new conversation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, changeSettings } = yield* setup({ label: "pending", watch: true });
        yield* changeSettings([
          connection,
          {
            ...connection,
            id: "new-keyed",
            credentialId: "credential",
            apiKey: Redacted.make("new-secret"),
          },
        ]);
        const refused = yield* client.setModel("scient_new-keyed", "local-model").pipe(Effect.flip);
        expect(refused.message).toBe(OMP_PENDING_CONNECTION_DETAIL);
        expect(refused.message).toContain("Start a new conversation to use this connection");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  );
});
