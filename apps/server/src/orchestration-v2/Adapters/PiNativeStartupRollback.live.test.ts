// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import { piInstanceStateRoot } from "../../provider/pi/PiSessionFile.ts";
import { makePiAdapterV2 } from "./PiAdapterV2.ts";
import { makePiRpcConnection, PiRpcError } from "./PiRpc.ts";
import { binary, ensure, fixture, json, layer } from "./PiNativeTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("native Pi unpublished startup ownership", (it) => {
  for (const leg of [
    "spawn",
    "startup",
    "binding-failure",
    "binding-cancellation",
    "parallel-close",
  ] as const) {
    it.effect.skipIf(!binary)(
      `rolls back only its fresh file after native ${leg}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* fixture(`rollback-${leg}`);
            yield* h.models("http://127.0.0.1:9/v1");
            const stateRoot = yield* piInstanceStateRoot({
              stateDir: h.adapterOptions.serverConfig.stateDir,
              instanceId: h.instanceId,
            });
            yield* h.fs.makeDirectory(stateRoot, { recursive: true });
            const root = yield* h.fs.realPath(stateRoot);
            const otherOwner = `${root}/other-owner.jsonl`;
            yield* h.fs.writeFileString(otherOwner, "Other owner's exact bytes\n");
            const entered = yield* Deferred.make<string>();
            const releaseBinding = yield* Deferred.make<void>();
            const cleanupEntered = yield* Deferred.make<void>();
            const releaseCleanup = yield* Deferred.make<void>();
            let nativePid: number | undefined;
            const pidFile = `${h.root}/native-pid`;
            yield* h.fs.makeDirectory(`${h.profile}/extensions`);
            yield* h.fs.writeFileString(
              `${h.profile}/extensions/pid.ts`,
              `import fs from "node:fs"; export default function () { fs.writeFileSync(${json(pidFile)}, String(process.pid)); }`,
            );
            let removedOwnedFile = false;
            const checkedFs = FileSystem.FileSystem.of({
              ...h.fs,
              remove: (target, options) =>
                Effect.gen(function* () {
                  if (String(target).startsWith(`${root}/`) && String(target) !== otherOwner) {
                    if (yield* h.fs.exists(pidFile)) {
                      const pid = nativePid ?? Number(yield* h.fs.readFileString(pidFile));
                      assert.throws(() => NodeProcess.kill(pid, 0), /ESRCH/);
                    }
                    removedOwnedFile = true;
                  }
                  yield* h.fs.remove(target, options);
                }),
            });
            const adapter = makePiAdapterV2({
              ...h.adapterOptions,
              fileSystem: checkedFs,
              settings: {
                ...h.adapterOptions.settings,
                binaryPath: leg === "spawn" ? `${h.root}/missing-pi-binary` : binary!,
              },
              makeConnection: (input) =>
                makePiRpcConnection(input).pipe(
                  Effect.flatMap((connection) =>
                    leg === "startup" || leg === "parallel-close"
                      ? connection.request({ type: "get_state" }).pipe(
                          Effect.mapError(
                            (cause) => new PiRpcError({ operation: "get_state", cause }),
                          ),
                          Effect.andThen(Deferred.succeed(entered, String(input.args.at(-1)))),
                          Effect.andThen(
                            leg === "startup"
                              ? Effect.never
                              : Effect.gen(function* () {
                                  nativePid = Number(
                                    yield* h.fs.readFileString(pidFile).pipe(Effect.orDie),
                                  );
                                  yield* Effect.addFinalizer(() =>
                                    Deferred.succeed(cleanupEntered, undefined).pipe(
                                      Effect.andThen(Deferred.await(releaseCleanup)),
                                    ),
                                  );
                                  return connection;
                                }),
                          ),
                        )
                      : Effect.succeed({
                          ...connection,
                          request: (record, timeout) =>
                            connection.request(record, timeout).pipe(
                              Effect.flatMap((result) =>
                                record.type !== "get_state"
                                  ? Effect.succeed(result)
                                  : Deferred.succeed(entered, String(input.args.at(-1))).pipe(
                                      Effect.andThen(
                                        leg === "binding-failure"
                                          ? Deferred.await(releaseBinding).pipe(
                                              Effect.andThen(
                                                Effect.fail(
                                                  new PiRpcError({
                                                    operation: "get_state",
                                                    detail:
                                                      "Controlled first-binding refusal after real native response",
                                                  }),
                                                ),
                                              ),
                                            )
                                          : leg === "binding-cancellation"
                                            ? Effect.never
                                            : Effect.succeed(result),
                                      ),
                                    ),
                              ),
                            ),
                        }),
                  ),
                ),
            });
            const open = adapter.openSession({
              threadId: h.threadId,
              providerSessionId: h.adapterOptions.idAllocator.derive.providerSession({
                providerInstanceId: h.instanceId,
              }),
              modelSelection: h.modelSelection,
              runtimePolicy: h.policy,
            });
            if (leg === "parallel-close") {
              const parent = yield* Scope.make("parallel");
              yield* Effect.addFinalizer(() => Scope.close(parent, Exit.void));
              yield* open.pipe(Scope.provide(parent));
              const ownedFile = yield* Deferred.await(entered);
              const closing = yield* Scope.close(parent, Exit.void).pipe(Effect.forkScoped);
              yield* Effect.gen(function* () {
                yield* Deferred.await(cleanupEntered).pipe(Effect.timeout("10 seconds"));
                assert.isTrue(yield* h.fs.exists(ownedFile));
                assert.doesNotThrow(() => NodeProcess.kill(nativePid!, 0));
              }).pipe(Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)));
              yield* Fiber.join(closing);
              assert.isFalse(yield* h.fs.exists(ownedFile));
            } else if (leg === "spawn") {
              assert.isTrue(Exit.isFailure(yield* Effect.exit(open)));
            } else if (leg === "startup") {
              const opening = yield* open.pipe(Effect.scoped, Effect.forkScoped);
              const ownedFile = yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
              assert.isTrue(yield* h.fs.exists(ownedFile));
              yield* Fiber.interrupt(opening);
              assert.isFalse(yield* h.fs.exists(ownedFile));
            } else {
              const runtime = yield* open;
              const registering = yield* ensure(h, runtime).pipe(Effect.exit, Effect.forkScoped);
              const ownedFile = yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
              assert.isTrue(yield* h.fs.exists(ownedFile));
              if (leg === "binding-cancellation") yield* Fiber.interrupt(registering);
              else {
                yield* Deferred.succeed(releaseBinding, undefined);
                assert.isTrue(Exit.isFailure(yield* Fiber.join(registering)));
              }
              assert.isFalse(yield* h.fs.exists(ownedFile));
            }
            assert.isTrue(removedOwnedFile);
            assert.deepEqual(yield* h.fs.readDirectory(root), ["other-owner.jsonl"]);
            assert.equal(yield* h.fs.readFileString(otherOwner), "Other owner's exact bytes\n");
          }),
        ),
      30000,
    );
  }

  for (const leg of ["failed", "cancelled"] as const) {
    it.effect.skipIf(!binary)(
      `preserves a published empty file across ${leg} resume startup`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* fixture(`resume-rollback-${leg}`);
            yield* h.models("http://127.0.0.1:9/v1");
            const publishedScope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(publishedScope, Exit.void));
            const originalRuntime = yield* h.open().pipe(Scope.provide(publishedScope));
            const original = yield* ensure(h, originalRuntime);
            const nativeFile = original.nativeThreadRef?.nativeId;
            if (nativeFile == null) return yield* Effect.die("Missing published session file");
            yield* Scope.close(publishedScope, Exit.void);
            const before = yield* h.fs.readFileString(nativeFile);
            assert.include(before, '"type":"session"');
            const entered = yield* Deferred.make<string>();
            const adapter = makePiAdapterV2({
              ...h.adapterOptions,
              settings: {
                ...h.adapterOptions.settings,
                binaryPath: leg === "failed" ? `${h.root}/missing-pi-binary` : binary!,
              },
              makeConnection: (input) =>
                makePiRpcConnection(input).pipe(
                  Effect.flatMap((connection) =>
                    connection.request({ type: "get_state" }).pipe(
                      Effect.mapError((cause) => new PiRpcError({ operation: "get_state", cause })),
                      Effect.andThen(h.fs.readFileString(nativeFile).pipe(Effect.orDie)),
                      Effect.flatMap((bytes) => Deferred.succeed(entered, bytes)),
                      Effect.andThen(Effect.never),
                    ),
                  ),
                ),
            });
            const opening = adapter.openSession({
              threadId: h.threadId,
              providerSessionId: originalRuntime.providerSessionId,
              modelSelection: h.modelSelection,
              runtimePolicy: h.policy,
              initialNativeThreadId: nativeFile,
            });
            let atCancellation = before;
            if (leg === "failed") assert.isTrue(Exit.isFailure(yield* Effect.exit(opening)));
            else {
              const fiber = yield* opening.pipe(Effect.scoped, Effect.forkScoped);
              atCancellation = yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
              assert.isTrue(atCancellation.startsWith(before));
              yield* Fiber.interrupt(fiber);
            }
            assert.equal(yield* h.fs.readFileString(nativeFile), atCancellation);
            const resumed = yield* h.open(nativeFile);
            const restored = yield* resumed.resumeThread({ providerThread: original });
            assert.equal(restored.nativeThreadRef?.nativeId, nativeFile);
            assert.equal(restored.id, original.id);
          }),
        ),
      30000,
    );
  }
});
