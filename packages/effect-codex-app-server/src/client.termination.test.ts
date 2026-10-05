import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as Client from "./client.ts";
import * as Errors from "./errors.ts";
import * as Replay from "./replay.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String, id: Schema.Number })),
);

const encodeReply = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Struct({ account: Schema.Null, requiresOpenaiAuth: Schema.Boolean }),
    }),
  ),
);

for (const outcome of ["eof", "failure"] as const) {
  it.effect(`forwards actual classified ${outcome} once after failing pending requests`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const ended = yield* Deferred.make<Errors.CodexAppServerError>();
        const calls = yield* Ref.make(0);
        const inputFailure = PlatformError.systemError({
          _tag: "Unknown",
          module: "Stdio",
          method: "stdin",
          cause: "controlled synthetic stdin failure",
        });
        const ownedStdio = Stdio.make({
          ...stdio,
          stdin:
            outcome === "failure"
              ? Stream.concat(stdio.stdin, Stream.fail(inputFailure))
              : stdio.stdin,
        });
        const client = yield* Client.make(ownedStdio, {
          onTermination: (error) =>
            Ref.update(calls, (n) => n + 1).pipe(
              Effect.andThen(Deferred.succeed(ended, error)),
              Effect.asVoid,
            ),
        });
        const pending = yield* client.raw.request("controlled/pending", {}).pipe(Effect.forkScoped);
        assert.equal(decodeRequest(yield* Queue.take(output)).method, "controlled/pending");
        yield* Queue.end(input);
        const error = yield* Deferred.await(ended);
        if (outcome === "eof") assert.instanceOf(error, Errors.CodexAppServerInputStreamEndedError);
        else {
          assert.ok(error._tag === "CodexAppServerTransportError");
          assert.equal(error.operation, "read-input-stream");
          assert.strictEqual(error.cause, inputFailure);
        }
        const failed = yield* Fiber.join(pending).pipe(Effect.exit);
        assert.equal(failed._tag, "Failure");
        if (failed._tag === "Failure") assert.strictEqual(Cause.squash(failed.cause), error);
        const refused = yield* client.raw.notify("controlled/after-exit", {}).pipe(Effect.exit);
        assert.equal(refused._tag, "Failure");
        if (refused._tag === "Failure") assert.strictEqual(Cause.squash(refused.cause), error);
        yield* Queue.end(input);
        assert.equal(yield* Ref.get(calls), 1);
      }),
    ),
  );
}

it.effect("preserves default typed request and EOF behavior without a termination callback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* Client.make(stdio);
      const pending = yield* client.request("account/read", {}).pipe(Effect.forkScoped);
      const request = decodeRequest(yield* Queue.take(output));
      assert.equal(request.method, "account/read");
      yield* Queue.offer(
        input,
        new TextEncoder().encode(
          encodeReply({
            id: request.id,
            result: { account: null, requiresOpenaiAuth: true },
          }) + "\n",
        ),
      );
      assert.deepEqual(yield* Fiber.join(pending), { account: null, requiresOpenaiAuth: true });
      const next = yield* client.raw.request("controlled/pending", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.end(input);
      const failed = yield* Fiber.join(next).pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure")
        assert.instanceOf(Cause.squash(failed.cause), Errors.CodexAppServerInputStreamEndedError);
    }),
  ),
);

it.effect(
  "forwards options through the actual replay client without changing driver expectations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* Replay.makeReplayDriver({
          provider: "codex",
          protocol: "codex.app-server",
          version: "0.144.0",
          scenario: "client-owned-termination",
          entries: [
            { type: "expect_outbound", frame: { id: 1, method: "controlled/pending", params: {} } },
            { type: "runtime_exit", status: "error", error: "synthetic transport failure" },
          ],
        });
        const ended = yield* Deferred.make<Errors.CodexAppServerError>();
        const calls = yield* Ref.make(0);
        const context = yield* Layer.build(
          Replay.layerReplayWithDriver(driver, {
            onTermination: (error) =>
              Ref.update(calls, (n) => n + 1).pipe(
                Effect.andThen(Deferred.succeed(ended, error)),
                Effect.asVoid,
              ),
          }),
        );
        const client = yield* Effect.service(Client.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
        const failed = yield* client.raw.request("controlled/pending", {}).pipe(Effect.exit);
        assert.equal(failed._tag, "Failure");
        assert.instanceOf(yield* Deferred.await(ended), Errors.CodexAppServerTransportError);
        assert.equal(yield* Ref.get(calls), 1);
        const state = yield* Ref.get(driver.state);
        assert.equal(state.cursor, 2);
        assert.instanceOf(state.failure, Replay.CodexAppServerReplayRuntimeExitError);
      }),
    ),
);
