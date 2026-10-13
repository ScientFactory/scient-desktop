import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  guardMuseTextGeneration,
  makeMuseAuth,
  readMuseDeviceInteraction,
  usesMuseApiKey,
} from "./MuseAuth.ts";
import * as Coordinator from "./ProviderLifecycleCoordinator.ts";

const instanceId = ProviderInstanceId.make("muse-auth-fixture");
const driver = ProviderDriverKind.make("muse");
const provider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.4.6-R6000.1",
  status: "ready",
  auth: { status: "unknown" },
  models: [],
  skills: [],
  slashCommands: [],
  checkedAt: "2026-10-13T00:00:00.000Z",
};
const snapshot: ManagedServerProvider = {
  getSnapshot: Effect.succeed(provider),
  refresh: Effect.succeed(provider),
  streamChanges: Stream.empty,
  applyUsageLimits: () => Effect.void,
  resolveMaintenance: () => Effect.succeed({ provider: driver, packageName: null, update: null }),
};
const phase = (controller: ProviderAuthController, value: ProviderAuthState["phase"]) =>
  controller.subscribe("owner").pipe(
    Stream.filter((state) => state.phase === value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const harness = Effect.fnUntraced(function* (
  environment: NodeJS.ProcessEnv = {},
  providerOverride = provider,
  beforeChange?: Effect.Effect<void, ProviderSetupError>,
) {
  const exit = yield* Deferred.make<number>();
  const spawned = yield* Deferred.make<ChildProcess.StandardCommand>();
  let input = "";
  let closed = false;
  let refreshed = 0;
  const coordinator = yield* Coordinator.make;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command))
        return yield* Effect.die("Expected a standard native command.");
      yield* Deferred.succeed(spawned, command);
      const stdin = command.options.stdin;
      if (Stream.isStream(stdin)) {
        const bytes = yield* stdin.pipe(Stream.runCollect);
        input = bytes.map((chunk) => new TextDecoder().decode(chunk)).join("");
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Deferred.await(exit).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.fromIterable([
          new TextEncoder().encode("https://auth.meta.com/device\nConfirm this "),
          new TextEncoder().encode("code matches:\nABCD-EFGH\n"),
        ]),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const auth = yield* makeMuseAuth({
    instanceId,
    binaryPath: "muse",
    cwd: process.cwd(),
    environment,
    snapshot: { ...snapshot, getSnapshot: Effect.succeed(providerOverride) },
    onChanged: Effect.sync(() => {
      refreshed++;
    }),
    ...(beforeChange ? { beforeChange } : {}),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(Coordinator.ProviderLifecycleCoordinator, coordinator),
  );
  return {
    ...auth,
    exit,
    spawned,
    coordinator,
    input: () => input,
    closed: () => closed,
    refreshed: () => refreshed,
  };
});

describe("Muse native account boundary", () => {
  it.effect("does not clear credentials through an unsupported runtime", () =>
    Effect.gen(function* () {
      const h = yield* harness({}, { ...provider, version: "1.4.5-R5999.1" });
      assert.strictEqual(
        (yield* h.controller.logout(Effect.void).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isFalse(Deferred.isDoneUnsafe(h.spawned));
      assert.isUndefined(yield* h.coordinator.currentForProvider(driver));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it("resolves explicit API keys with platform-correct environment case semantics", () => {
    assert.isFalse(usesMuseApiKey({ meta_api_key: "fixture" }, "darwin"));
    assert.isFalse(usesMuseApiKey({ meta_api_key: "fixture" }, "linux"));
    assert.isTrue(usesMuseApiKey({ meta_api_key: "fixture" }, "win32"));
    assert.isTrue(usesMuseApiKey({ META_API_KEY: "fixture" }, "darwin"));
    assert.isFalse(usesMuseApiKey({ meta_api_key: "fixture", META_API_KEY: "" }, "win32"));
  });
  it("extracts a device interaction, not a callback to paste into Scient", () => {
    assert.deepEqual(
      readMuseDeviceInteraction(
        "\u001b[1mhttps://auth.meta.com/device\u001b[0m\nEnter this code:\nABCD-EFGH\n",
      ),
      { url: "https://auth.meta.com/device", userCode: "ABCD-EFGH" },
    );
    // A code cut at an output-chunk boundary is not published until it is complete.
    assert.isUndefined(
      readMuseDeviceInteraction(
        "https://auth.meta.com/device\nconfirm this code matches:\nABCD-EF",
      ),
    );
    // Shape printed by a non-interactive Muse 1.4.6-R6000.1 `muse login`.
    assert.deepEqual(
      readMuseDeviceInteraction(
        "Open this page to sign in:\n  https://auth.meta.com/oauth/device/?user_code=ABCD-EFGH\nconfirm this code matches:\n  ABCD-EFGH\n\nWaiting for approval…\n",
      ),
      {
        url: "https://auth.meta.com/oauth/device/?user_code=ABCD-EFGH",
        userCode: "ABCD-EFGH",
      },
    );
    for (const url of [
      "http://auth.meta.com/device",
      "https://auth.meta.com.example.test/device",
      "https://user:password@auth.meta.com/device",
      "https://auth.meta.com:8443/device",
    ]) {
      assert.isUndefined(readMuseDeviceInteraction(`${url}\nEnter this code: ABCD-EFGH`));
    }
  });

  it.effect(
    "supervises one login, hides codes from other clients and reports unverified completion",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const started = yield* h.controller.start("owner", Effect.void, "muse_device");
        const command = yield* Deferred.await(h.spawned);
        assert.deepEqual(command.args, ["login"]);
        assert.strictEqual(command.options.extendEnv, false);
        assert.strictEqual(command.options.env?.MUSE_NO_AUTO_UPDATE, "1");
        const waiting = yield* phase(h.controller, "waiting");
        assert.strictEqual(waiting.interaction?.type, "deviceCode");
        const other = yield* h.controller
          .subscribe("other")
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        assert.isNull(other.interaction);
        assert.isNull(other.flowId);
        assert.isDefined(yield* h.coordinator.currentForProvider(driver));
        yield* Deferred.succeed(h.exit, 0);
        const done = yield* phase(h.controller, "idle");
        assert.strictEqual(done.accountVerified, false);
        assert.include(done.message ?? "", "Muse saved your sign-in.");
        assert.isNull(done.interaction);
        assert.isTrue(h.closed());
        assert.strictEqual(h.refreshed(), 1);
        assert.isUndefined(yield* h.coordinator.currentForProvider(driver));
        assert.isDefined(started.flowId);
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect("writes a supplied API key only to stdin through the current owned interaction", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.controller.start("owner", Effect.void, "muse_key");
      const waiting = yield* phase(h.controller, "waiting");
      assert.strictEqual(waiting.interaction?.type, "credentials");
      const response = {
        instanceId,
        flowId: waiting.flowId!,
        interactionId: waiting.interaction!.id,
        response: { type: "credentials" as const, values: { apiKey: "fixture-key" } },
      };
      assert.strictEqual(
        (yield* h.controller.respond!("other", response).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* h.controller.respond!("owner", response);
      const command = yield* Deferred.await(h.spawned);
      assert.deepEqual(command.args, ["auth", "set", "--api-key-stdin"]);
      assert.strictEqual(h.input(), "fixture-key\n");
      assert.isFalse(JSON.stringify(command.options.env).includes("fixture-key"));
      yield* Deferred.succeed(h.exit, 0);
      const done = yield* phase(h.controller, "idle");
      assert.isFalse(JSON.stringify(done).includes("fixture-key"));
      assert.strictEqual(done.accountVerified, false);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("does not overwrite an explicit API-key instance's billing context", () =>
    Effect.gen(function* () {
      const h = yield* harness({ META_API_KEY: "fixture-explicit-key" });
      const methods = yield* h.controller.subscribe("owner").pipe(
        Stream.filter((state) => state.methods !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.deepEqual(methods.methods, []);
      yield* h.controller.start("owner");
      const failed = yield* phase(h.controller, "failed");
      assert.include(failed.message ?? "", "did not advertise");
      assert.strictEqual(
        (yield* h.controller.logout(Effect.void).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isFalse(Deferred.isDoneUnsafe(h.spawned));
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("a routed session-stop failure is retryable and releases the lifecycle lease", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const stopped = Effect.fail(
        new ProviderSetupError({
          instanceId,
          operation: "stopSessions",
          detail: "Fixture routed-stop failure.",
        }),
      );
      yield* h.controller.start("owner", stopped, "muse_device");
      const failed = yield* phase(h.controller, "failed");
      assert.include(failed.message ?? "", "Fixture routed-stop failure.");
      assert.isFalse(Deferred.isDoneUnsafe(h.spawned));
      // The failed phase is published just before the flow settles.
      for (let turn = 0; turn < 100 && (yield* h.controller.isChangingCredentials!); turn++)
        yield* Effect.yieldNow;
      assert.isFalse(yield* h.controller.isChangingCredentials!);
      assert.isUndefined(yield* h.coordinator.currentForProvider(driver));
      assert.strictEqual(
        (yield* h.controller.withAccess!(Effect.void).pipe(Effect.result))._tag,
        "Success",
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("a failed native close keeps the account locked until restart", () =>
    Effect.gen(function* () {
      const h = yield* harness(
        {},
        provider,
        Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "stopSessions",
            detail: "Fixture native-close failure.",
          }),
        ),
      );
      yield* h.controller.start("owner", Effect.void, "muse_device");
      const failed = yield* phase(h.controller, "failed");
      assert.include(failed.message ?? "", "could not finish closing");
      assert.isFalse(Deferred.isDoneUnsafe(h.spawned));
      assert.isDefined(yield* h.coordinator.currentForProvider(driver));
      assert.isTrue(yield* h.controller.isChangingCredentials!);
      assert.strictEqual(
        (yield* h.controller.withAccess!(Effect.void).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("an explicit-key instance keeps running during another instance's sign-in", () =>
    Effect.gen(function* () {
      const h = yield* harness({ META_API_KEY: "fixture-key" });
      const other = ProviderInstanceId.make("muse-native-login-fixture");
      assert.isTrue(
        yield* h.coordinator.reserve({
          instanceId: other,
          provider: driver,
          exclusiveProvider: true,
          reservation: { operationId: "fixture-login", kind: "connection" },
        }),
      );
      assert.strictEqual(
        (yield* h.controller.withAccess!(Effect.void).pipe(Effect.result))._tag,
        "Success",
      );
      yield* h.coordinator.release({ operationId: "fixture-login" });
      assert.isTrue(
        yield* h.coordinator.reserve({
          instanceId: other,
          provider: driver,
          reservation: { operationId: "fixture-update", kind: "runtime" },
        }),
      );
      assert.strictEqual(
        (yield* h.controller.withAccess!(Effect.void).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("never writes credentials while another owner holds the lifecycle lease", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const other = ProviderInstanceId.make("muse-maintenance-fixture");
      assert.isTrue(
        yield* h.coordinator.reserve({
          instanceId: other,
          provider: driver,
          reservation: { operationId: "fixture-install", kind: "runtime" },
        }),
      );
      let stopped = false;
      yield* h.controller.start(
        "owner",
        Effect.sync(() => {
          stopped = true;
        }),
        "muse_device",
      );
      yield* phase(h.controller, "failed");
      assert.isTrue(stopped);
      assert.isFalse(Deferred.isDoneUnsafe(h.spawned));
      assert.strictEqual(
        (yield* h.coordinator.currentForProvider(driver))?.operationId,
        "fixture-install",
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("cancellation closes the owned process before releasing the lifecycle lease", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.controller.start("owner", Effect.void, "muse_device");
      const waiting = yield* phase(h.controller, "waiting");
      yield* h.controller.cancel("owner", waiting.flowId!);
      assert.isTrue(h.closed());
      assert.isUndefined(yield* h.coordinator.currentForProvider(driver));
      assert.strictEqual((yield* phase(h.controller, "cancelled")).phase, "cancelled");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("a failed native credential write never succeeds or exposes native output", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.controller.start("owner", Effect.void, "muse_device");
      yield* Deferred.await(h.spawned);
      yield* Deferred.succeed(h.exit, 2);
      const state = yield* phase(h.controller, "failed");
      assert.strictEqual(state.accountVerified, false);
      assert.isNull(state.interaction);
      assert.isFalse(JSON.stringify(state).includes("ABCD-EFGH"));
      assert.isTrue(h.closed());
      assert.isUndefined(yield* h.coordinator.currentForProvider(driver));
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports a sign-in that stops in-flight generation as a generation error", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const entered = yield* Deferred.make<void>();
      const unused = () => Effect.die("Not used by this test.");
      const generation = guardMuseTextGeneration(h.controller, {
        generateCommitMessage: unused,
        generatePrContent: unused,
        generateThreadTitle: unused,
        generateReviewGuide: unused,
        generateBranchName: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const input = { cwd: process.cwd(), message: "Fixture", modelSelection: {} as never };
      const running = yield* generation.generateBranchName(input).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* h.controller.start("owner", Effect.void, "muse_device");
      const exit = yield* Fiber.await(running);
      assert.isTrue(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause));
      // While the account lease is held, new generation is refused.
      yield* Deferred.await(h.spawned);
      assert.strictEqual(
        (yield* generation.generateBranchName(input).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
