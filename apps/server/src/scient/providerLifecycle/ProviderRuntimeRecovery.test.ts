import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ProviderRuntimeManager, type ProviderRuntimeOutcome } from "./ProviderRuntimeManager.ts";
import { make as makeRecovery } from "./ProviderRuntimeRecovery.ts";
import { make as makeRequests, ProviderRuntimeRequests } from "./ProviderRuntimeRequests.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const CODEX = ProviderDriverKind.make("codex");
const MINUTE = 60_000;

const runtime: ProviderRuntimeSummary = {
  source: "missing",
  supportTier: "fully_assisted",
  target: "darwin-arm64",
  actions: ["install"],
  managedVersion: null,
  previousManagedVersion: null,
  operation: null,
  message: "Codex setup is available.",
};

const codex: ServerProvider = {
  instanceId: INSTANCE,
  driver: CODEX,
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-11-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: { methods: [], canDisconnect: false, operation: null, runtime },
};

const plan = (catalogRevision: string) => ({
  instanceId: INSTANCE,
  action: "install" as const,
  target: "darwin-arm64",
  version: "0.147.0",
  downloadBytes: 100,
  sourceLabel: "Official OpenAI release",
  catalogRevision,
  message: "Install reviewed Codex.",
});

const request = {
  requestId: "requested-install",
  instanceId: INSTANCE,
  driver: CODEX,
  action: "install" as const,
  catalogRevision: "reviewed:1",
};

describe("ProviderRuntimeRequests", () => {
  it.effect("keeps the user's request across a restart without making it due at once", () =>
    Effect.gen(function* () {
      const before = yield* makeRequests();
      yield* before.requested(request);
      const after = yield* makeRequests();
      const [kept] = yield* after.list;
      assert.deepInclude(kept, { ...request, retries: 0 });
      // A restart while the user's own download runs waits as long as a failure would.
      assert.isAtLeast(kept!.dueAt, (yield* Clock.currentTimeMillis) + 4 * MINUTE);
      yield* after.requested({ ...request, action: "remove" });
      assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-requests-" }).pipe(
          Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect(
    "retains the visible and persisted request when cancellation cannot be written, then retries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const denied = yield* Ref.make(false);
        const guardedFs = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Ref.get(denied).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : fs.rename(from, to),
              ),
            ),
        });
        const requests = yield* makeRequests().pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        yield* requests.requested(request);
        const before = yield* requests.list;
        yield* Ref.set(denied, true);
        const failure = yield* requests
          .settled({ ...request, outcome: "cancelled" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ProviderRuntimeRequestsPersistenceError");
        assert.deepStrictEqual(yield* requests.list, before);
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, before);
        yield* Ref.set(denied, false);
        yield* requests.settled({ ...request, outcome: "cancelled" });
        assert.deepStrictEqual(yield* requests.list, []);
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-requests-denied-" }).pipe(
            Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );

  it.effect.each(["malformed", "denied"] as const)(
    "preserves an unreadable journal and disables only managed changes (%s)",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const file = path.join(config.baseDir, "provider-runtimes", ".background", "requests.json");
        const contents = mode === "malformed" ? "{broken" : "[]";
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, contents);
        const guardedFs = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (target, encoding) =>
            mode === "denied" && target === file
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: target,
                  }),
                )
              : fs.readFileString(target, encoding),
        });
        const requests = yield* makeRequests().pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        const unavailable = yield* requests.assertAvailable.pipe(Effect.flip);
        assert.strictEqual(unavailable._tag, "ProviderRuntimeRequestsPersistenceError");
        for (const mutation of [
          requests.requested(request),
          requests.update(request.requestId, () => undefined),
          requests.settled({ ...request, outcome: "cancelled" }),
        ]) {
          assert.strictEqual((yield* mutation.pipe(Effect.flip))._tag, unavailable._tag);
        }
        assert.strictEqual(yield* fs.readFileString(file), contents);
        yield* fs.writeFileString(file, "[]");
        const restarted = yield* makeRequests();
        yield* restarted.assertAvailable;
        yield* restarted.requested(request);
        assert.deepInclude((yield* (yield* makeRequests()).list)[0], request);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-requests-unavailable-" }).pipe(
            Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );

  it.effect.each([1_000, 2 * 60 * MINUTE])(
    "persists the later of retry jitter and the source cooldown (%s ms)",
    (retryAfterMs) =>
      Effect.gen(function* () {
        const requests = yield* makeRequests();
        yield* requests.requested(request);
        const now = yield* Clock.currentTimeMillis;
        yield* requests.settled({ ...request, outcome: "retryable", retryAfterMs });
        const [kept] = yield* (yield* makeRequests()).list;
        assert.deepInclude(kept, request);
        assert.isAtLeast(kept!.dueAt, now + Math.max(retryAfterMs, 4 * MINUTE));
        assert.isAtMost(kept!.dueAt, now + Math.max(retryAfterMs, 6 * MINUTE));
        const replacement = { ...request, requestId: "replacement", catalogRevision: "reviewed:2" };
        yield* requests.requested(replacement);
        yield* requests.settled({ ...request, outcome: "cancelled" });
        yield* requests.update(request.requestId, () => undefined);
        assert.deepInclude((yield* requests.list)[0], replacement);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-source-cooldown-" }).pipe(
            Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});

describe("ProviderRuntimeRecovery", () => {
  // The clock owns retry deadlines; starts record completed attempts.
  const harness = (catalogRevision: string) =>
    Effect.gen(function* () {
      const starts = yield* SubscriptionRef.make<ReadonlyArray<{ attempt: number; at: number }>>(
        [],
      );
      const requests = yield* makeRequests();
      yield* requests.requested(request);
      // The user's own try failed in a way a later try can fix.
      yield* requests.settled({ instanceId: INSTANCE, driver: CODEX, outcome: "retryable" });
      yield* makeRecovery().pipe(
        Effect.provideService(ProviderRuntimeRequests, requests),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed([codex]),
              streamChanges: Stream.never,
            }),
            Layer.mock(ProviderRuntimeManager)({
              plan: () => Effect.succeed(plan(catalogRevision)),
              // As the manager does: a failure that may pass keeps the request.
              startInBackground: (input) =>
                Effect.gen(function* () {
                  const at = yield* Clock.currentTimeMillis;
                  yield* requests
                    .settled({
                      instanceId: input.instanceId,
                      driver: CODEX,
                      outcome: "retryable",
                    })
                    .pipe(Effect.orDie);
                  yield* SubscriptionRef.update(starts, (all) => [
                    ...all,
                    { attempt: input.attempt, at },
                  ]);
                  return "failed" as ProviderRuntimeOutcome;
                }),
            }),
          ),
        ),
      );
      const runFor = (minutes: number) =>
        Effect.forEach(
          Array.from({ length: minutes }),
          () =>
            Effect.gen(function* () {
              const nextMinute = (yield* Clock.currentTimeMillis) + MINUTE;
              const due = (yield* requests.list).some((pending) => pending.dueAt <= nextMinute);
              const completed = (yield* SubscriptionRef.get(starts)).length;
              yield* TestClock.adjust("1 minute");
              if (!due) return;
              // Real durable writes are external to TestClock. Await the completed transition
              // before advancing again, rather than racing fsync with the simulated clock.
              if (catalogRevision === request.catalogRevision) {
                yield* SubscriptionRef.changes(starts).pipe(
                  Stream.filter((entries) => entries.length > completed),
                  Stream.runHead,
                );
              } else {
                yield* requests.changes.pipe(
                  Stream.filter(
                    (pending) => !pending.some((entry) => entry.requestId === request.requestId),
                  ),
                  Stream.runHead,
                );
              }
            }),
          { discard: true },
        );
      return { starts, requests, runFor };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-recovery-" }).pipe(
          Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );

  it.effect("tries again about 5 minutes, then 30 minutes, then 2 hours after each failure", () =>
    Effect.gen(function* () {
      const { starts, runFor } = yield* harness("reviewed:1");
      yield* runFor(4 * 60);
      const tries = yield* SubscriptionRef.get(starts);
      assert.deepStrictEqual(
        tries.map((entry) => entry.attempt),
        [1, 2, 3],
      );
      const [first, second, third] = tries.map((entry) => entry.at / MINUTE);
      // Jittered by a fifth either way, then picked up at the next one-minute check.
      assert.isTrue(first! >= 4 && first! <= 7, `first try at ${first}`);
      assert.isTrue(second! - first! >= 24 && second! - first! <= 37, `second at ${second}`);
      assert.isTrue(third! - second! >= 96 && third! - second! <= 145, `third at ${third}`);
    }),
  );

  it.effect("drops the request when the plan changed instead of installing another one", () =>
    Effect.gen(function* () {
      const { starts, requests, runFor } = yield* harness("reviewed:2");
      yield* runFor(10);
      assert.deepStrictEqual(yield* SubscriptionRef.get(starts), []);
      assert.deepStrictEqual(yield* requests.list, []);
    }),
  );
});
