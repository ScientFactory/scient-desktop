// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";

import type { ResolvedModelConnection } from "../../customModels.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory, type OmpCustomModelsTiming } from "./OmpCustomModels.ts";
import { makeFakeOmpModelsExtension } from "./OmpCustomModelsTestHelpers.ts";
import { OMP_PENDING_CONNECTION_DETAIL } from "./OmpModel.ts";
import type { OmpRpcProcess, OmpRpcProcessOptions } from "./OmpRpcProcess.ts";

const instanceId = ProviderInstanceId.make("omp-barrier-test");
const model = {
  id: "model",
  modelId: "local-model",
  name: "Local model",
  configurationMode: "manual" as const,
  contextWindow: 32_000,
  maxOutputTokens: 2_048,
  images: false,
  reasoning: false,
  instanceIds: [instanceId],
};
const connection: ResolvedModelConnection = {
  id: "local",
  name: "Local",
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialId: null,
  apiKey: null,
  models: [model],
};
const secondModel = { ...model, id: "second", modelId: "second-model" };

const response = (command: string) => ({
  id: "barrier-test",
  type: "response" as const,
  command,
  success: true,
});

type FakeExtension = ReturnType<typeof makeFakeOmpModelsExtension>;

/** A native OMP stand-in whose model registry is whatever the extension registered. */
const fakeNative = (extension: FakeExtension): OmpRpcProcess =>
  ({
    version: "18.3.1",
    ready: Effect.succeed({
      type: "ready" as const,
      protocolVersion: 2,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    }),
    events: Stream.empty,
    flushEvents: () => Effect.void,
    getModels: () => Effect.sync(() => ({ models: extension.models() })),
    getState: () => Effect.succeed({ isStreaming: false }),
    getCommands: () => Effect.succeed({ commands: [] }),
    prompt: () => Effect.succeed(response("prompt")),
    setThinkingLevel: () => Effect.succeed(response("set_thinking_level")),
    setModel: (provider: string, modelId: string) =>
      Effect.suspend(() =>
        extension.models().some((entry) => entry.provider === provider && entry.id === modelId)
          ? Effect.succeed(response("set_model"))
          : Effect.fail(
              new OmpRpcCommandError({
                command: "set_model",
                detail: `Model not found: ${provider}/${modelId}`,
              }),
            ),
      ),
    close: () => Effect.void,
    shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
  }) as unknown as OmpRpcProcess;

/** A raw TCP client of the loopback endpoint that writes `text` and records when it closes. */
const rawSocket = (url: string, text: string) =>
  new Promise<{
    readonly closed: Promise<void>;
    readonly closedAfterMs: () => number;
    readonly received: () => string;
  }>((resolve, reject) => {
    const { port } = new URL(url);
    const opened = performance.now();
    let closedAt = Number.NaN;
    let received = "";
    const socket = NodeNet.connect(Number(port), "127.0.0.1");
    const closed = new Promise<void>((done) =>
      socket.once("close", () => {
        closedAt = performance.now();
        done();
      }),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.once("error", () => undefined);
    socket.once("connect", () => {
      if (text) socket.write(text);
      resolve({ closed, closedAfterMs: () => closedAt - opened, received: () => received });
    });
    socket.once("error", reject);
  });

const setup = (input: {
  readonly label: string;
  readonly timing?: OmpCustomModelsTiming;
  /** Start the extension's own watch loop (otherwise the test drives it). */
  readonly watch: boolean;
}) =>
  Effect.gen(function* () {
    const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-barrier-${process.pid}-${input.label}`);
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.mkdirSync(root, { recursive: true });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const state = {
      current: [connection] as ReadonlyArray<ResolvedModelConnection>,
      resolutions: 0,
    };
    const settingsChanges = yield* Queue.unbounded<ServerSettings>();
    let extension: FakeExtension | undefined;
    const factory = yield* makeOmpCustomModelsClientFactory(
      {
        resolveCustomModels: () =>
          Effect.sync(() => {
            state.resolutions += 1;
            return state.current;
          }),
        subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
      },
      instanceId,
      NodePath.join(root, "state"),
      (options: OmpRpcProcessOptions) =>
        Effect.sync(() => {
          extension = makeFakeOmpModelsExtension(options);
          return fakeNative(extension);
        }),
      input.timing,
    );
    const client = yield* factory({ command: "fake-omp", env: { PATH: "" } });
    if (!extension) throw new Error("fake process was not launched");
    const loaded = extension;
    yield* Effect.addFinalizer(() => Effect.sync(() => loaded.stop()));
    if (input.watch) yield* Effect.promise(() => loaded.start());
    else yield* Effect.promise(() => loaded.refresh());
    /** Publish a settings snapshot and wait until the bridge has read it. */
    const changeSettings = (next: ReadonlyArray<ResolvedModelConnection>, revision?: number) =>
      Effect.gen(function* () {
        const before = state.resolutions;
        state.current = next;
        yield* Queue.offer(settingsChanges, {
          customModels: { revision: revision ?? before + 100, connections: [] },
        } as unknown as ServerSettings);
        for (let attempt = 0; attempt < 200 && state.resolutions === before; attempt += 1) {
          yield* Effect.sleep("5 millis");
        }
      });
    return { client, extension: loaded, state, settingsChanges, changeSettings };
  });

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
        yield* Effect.sleep("30 millis");
        expect(refresh.pollUnsafe()).toBeUndefined();
        yield* Effect.promise(() => extension.refresh());
        expect(Exit.isSuccess(yield* Fiber.await(refresh))).toBe(true);
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
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
        yield* Effect.sleep("30 millis");
        extension.register(stale);
        expect(yield* Effect.promise(() => extension.acknowledge(stale.generation))).toBe(204);
        yield* Effect.sleep("30 millis");
        expect(refresh.pollUnsafe()).toBeUndefined();
        const fresh = yield* Effect.promise(() => extension.load());
        expect(fresh.generation).toBe(3);
        extension.register(fresh);
        yield* Effect.promise(() => extension.acknowledge(fresh.generation));
        expect(Exit.isSuccess(yield* Fiber.await(refresh))).toBe(true);
        // A generation Scient never published cannot be acknowledged ahead.
        expect(yield* Effect.promise(() => extension.acknowledge(99))).toBe(204);
        const late = yield* Effect.forkChild(client.refreshModels!());
        yield* Effect.sleep("30 millis");
        expect(late.pollUnsafe()).toBeUndefined();
        yield* Effect.promise(() => extension.refresh());
        expect(Exit.isSuccess(yield* Fiber.await(late))).toBe(true);
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
  );

  it.effect("M-5 timeout, failed registration, and retirement return typed errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, extension, changeSettings } = yield* setup({
          label: "typed",
          watch: false,
          timing: { refreshTimeoutMs: 150 },
        });
        const timeout = yield* client.refreshModels!().pipe(Effect.flip);
        expect(timeout).toMatchObject({ _tag: "OmpModelRefreshError", reason: "timeout" });
        expect(timeout.message).toMatch(/within 1 seconds/u);

        const failing = yield* Effect.forkChild(client.refreshModels!());
        yield* Effect.sleep("20 millis");
        const body = yield* Effect.promise(() => extension.load());
        yield* Effect.promise(() => extension.acknowledge(body.generation, "invalid model schema"));
        const failed = yield* Fiber.join(failing).pipe(Effect.flip);
        expect(failed).toMatchObject({ _tag: "OmpModelRefreshError", reason: "failed" });
        expect(failed.message).toContain("invalid model schema");

        const retiring = yield* Effect.forkChild(client.refreshModels!());
        yield* Effect.sleep("20 millis");
        // A removed model revokes the bridge: the process must be replaced.
        yield* changeSettings([{ ...connection, models: [] }]);
        const retired = yield* Fiber.join(retiring).pipe(Effect.flip);
        expect(retired).toMatchObject({ _tag: "OmpModelRefreshError", reason: "retired" });
        expect(yield* client.getState().pipe(Effect.flip)).toMatchObject({
          message: expect.stringContaining("retired"),
        });
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
  );

  it.effect("holds the long-poll past the request timeout and wakes on a change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { extension, changeSettings } = yield* setup({
          label: "long-poll",
          watch: false,
          // Node enforces its request timeout on this interval; without a
          // short one a 400 ms hold would outlive a 100 ms timeout trivially.
          timing: { requestTimeoutMs: 100, waitHoldMs: 400, connectionsCheckingIntervalMs: 10 },
        });
        // The timeout is really enforced: a request whose headers never
        // finish is cut off...
        const slow = yield* Effect.promise(() =>
          rawSocket(extension.url, "GET /models HTTP/1.1\r\n"),
        );
        yield* Effect.promise(() => slow.closed);
        expect(slow.closedAfterMs()).toBeLessThan(1_000);
        // ...but a received long-poll is not.
        const started = yield* Clock.currentTimeMillis;
        const idle = yield* Effect.promise(() => extension.wait(extension.applied()));
        expect(idle).toEqual({ status: 200, generation: extension.applied() });
        expect((yield* Clock.currentTimeMillis) - started).toBeGreaterThanOrEqual(350);

        const waiting = yield* Effect.forkChild(
          Effect.promise(() => extension.wait(extension.applied())),
        );
        yield* Effect.sleep("30 millis");
        const changedAt = yield* Clock.currentTimeMillis;
        yield* changeSettings([{ ...connection, models: [model, secondModel] }]);
        const woke = yield* Fiber.join(waiting);
        expect(woke.generation).toBe(extension.applied() + 1);
        expect((yield* Clock.currentTimeMillis) - changedAt).toBeLessThan(300);
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
  );

  it.effect("idle and unauthenticated sockets cannot starve the extension", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { extension } = yield* setup({
          label: "starve",
          watch: false,
          timing: { requestTimeoutMs: 200, connectionsCheckingIntervalMs: 10 },
        });
        // Local processes open connections that never authenticate: some send
        // nothing, some stall mid-headers.
        const idle = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 8 }, (_, index) =>
              rawSocket(extension.url, index % 2 === 0 ? "" : "GET /models HTTP/1.1\r\n"),
            ),
          ),
        );
        // The extension is still served, on a new connection.
        const status = yield* Effect.promise(
          () =>
            new Promise<number | string>((resolve) => {
              const request = NodeHttp.get(
                extension.url,
                { agent: false, headers: extension.headers, timeout: 2_000 },
                (response) => {
                  response.resume();
                  resolve(response.statusCode ?? 0);
                },
              );
              request.once("error", (error) => resolve(error.message));
              request.once("timeout", () => request.destroy(new Error("timed out")));
            }),
        );
        expect(status).toBe(200);
        // Every idle socket is closed by the server soon after.
        yield* Effect.promise(() => Promise.all(idle.map((socket) => socket.closed)));
        expect(Math.max(...idle.map((socket) => socket.closedAfterMs()))).toBeLessThan(2_000);
        // A request with the wrong token is refused and its connection closed.
        const refused = yield* Effect.promise(() =>
          rawSocket(
            extension.url,
            "GET /models HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer wrong\r\n\r\n",
          ),
        );
        yield* Effect.promise(() => refused.closed);
        expect(refused.received()).toMatch(/^HTTP\/1\.1 403 /u);
        expect(refused.closedAfterMs()).toBeLessThan(1_000);
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
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
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
  );

  it.effect("M-7 guarded RPCs never read the secret store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, state, changeSettings, settingsChanges } = yield* setup({
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
        yield* Queue.offer(settingsChanges, {
          customModels: { revision: 7, connections: [] },
        } as unknown as ServerSettings);
        yield* Effect.sleep("50 millis");
        yield* client.getModels();
        expect(state.resolutions).toBe(2);
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
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
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer)),
      TestClock.withLive,
    ),
  );
});
