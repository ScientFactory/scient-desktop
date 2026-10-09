import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { makePiAdapterV2 } from "@t3tools/provider-pi/testing";
import { makePiRpcConnection, type PiRpcRecord } from "@t3tools/provider-pi/testing";
import { binary, ensure, fixture, layer } from "./PiNativeTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("native Pi launch binding", (it) => {
  for (const target of ["launched", "different"] as const) {
    it.effect.skipIf(!binary)(
      `first resume verifies the native ${target} file and retains later lifecycle requests`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* fixture(`launch-binding-${target}`);
            yield* h.models("http://127.0.0.1:9/v1");
            const originalScope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(originalScope, Exit.void));
            const original = yield* h.open().pipe(Scope.provide(originalScope));
            const first = yield* ensure(h, original);
            const launchedFile = first.nativeThreadRef?.nativeId;
            if (launchedFile == null) return yield* Effect.die("Missing native launch file");
            const expected =
              target === "launched"
                ? first
                : yield* ensure(h, yield* h.open().pipe(Scope.provide(originalScope)));
            const expectedFile = expected.nativeThreadRef?.nativeId;
            if (expectedFile == null) return yield* Effect.die("Missing native target file");
            if (target === "different") assert.notEqual(expectedFile, launchedFile);
            assert.isTrue(yield* h.fs.exists(expectedFile));
            yield* Scope.close(originalScope, Exit.void);
            const requests: PiRpcRecord[] = [];
            const adapter = yield* makePiAdapterV2({
              ...h.adapterOptions,
              makeConnection: (input) =>
                makePiRpcConnection(input).pipe(
                  Effect.map((connection) => ({
                    ...connection,
                    request: (record, timeout) =>
                      Effect.sync(() => requests.push(record)).pipe(
                        Effect.andThen(connection.request(record, timeout)),
                      ),
                  })),
                ),
            });
            const runtime = yield* adapter.openSession({
              threadId: h.threadId,
              providerSessionId: original.providerSessionId,
              modelSelection: h.modelSelection,
              runtimePolicy: h.policy,
              initialNativeThreadId: launchedFile,
            });
            const restored = yield* runtime.resumeThread({ providerThread: expected });
            assert.equal(restored.id, expected.id);
            assert.equal(restored.nativeThreadRef?.nativeId, expectedFile);
            assert.isTrue(requests.some((record) => record.type === "get_state"));
            assert.deepEqual(
              requests
                .filter((record) => record.type === "switch_session")
                .map((r) => r.sessionPath),
              target === "launched" ? [] : [expectedFile],
            );
            const later = yield* runtime.resumeThread({ providerThread: restored });
            assert.equal(later.nativeThreadRef?.nativeId, expectedFile);
            assert.deepEqual(
              requests
                .filter((record) => record.type === "switch_session")
                .map((r) => r.sessionPath),
              target === "launched" ? [expectedFile] : [expectedFile, expectedFile],
            );
            assert.isFalse(requests.some((record) => record.type === "new_session"));
            assert.isTrue(yield* h.fs.exists(launchedFile));
            assert.isTrue(yield* h.fs.exists(expectedFile));
          }),
        ),
      30000,
    );
  }
});
