// @effect-diagnostics nodeBuiltinImport:off -- private loopback fixtures own temporary bootstrap state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";
import type { ResolvedModelConnection } from "../../customModels.ts";
import {
  makeOmpCustomModelsClientFactory,
  type OmpCustomModelsTiming,
  type OmpCustomModelsWaitSnapshot,
} from "./OmpCustomModels.ts";
import { makeFakeOmpModelsExtension } from "./OmpCustomModelsTestHelpers.ts";
import type { OmpRpcProcess, OmpRpcProcessOptions } from "./OmpRpcProcess.ts";
import { ompTarget } from "./OmpTarget.ts";

const instanceId = ProviderInstanceId.make("omp-barrier-test");
export const model = {
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
export const connection = {
  id: "local",
  name: "Local",
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialId: null,
  apiKey: null,
  models: [model],
} satisfies ResolvedModelConnection;
export const secondModel = { ...model, id: "second", modelId: "second-model" };

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

export const setup = Effect.fn("test.OmpCustomModels.setup")(function* (input: {
  readonly label: string;
  readonly timing?: OmpCustomModelsTiming;
  /** Start the extension's own watch loop (otherwise the test drives it). */
  readonly watch: boolean;
}) {
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
  const waitSnapshots = yield* Effect.acquireRelease(
    Queue.unbounded<OmpCustomModelsWaitSnapshot>(),
    Queue.shutdown,
  );
  const processedSettings = new WeakMap<ServerSettings, () => void>();
  let extension: FakeExtension | undefined;
  const factory = yield* makeOmpCustomModelsClientFactory(
    ompTarget,
    {
      resolveCustomModels: () =>
        Effect.sync(() => {
          state.resolutions += 1;
          return state.current;
        }),
      subscribeChanges: Effect.succeed(
        Stream.fromQueue(settingsChanges).pipe(
          Stream.flatMap((next) =>
            Stream.concat(
              Stream.succeed(next),
              // The next pull follows the bridge's sequential snapshot handler.
              Stream.fromEffectDrain(
                Effect.sync(() => {
                  processedSettings.get(next)?.();
                  processedSettings.delete(next);
                }),
              ),
            ),
          ),
        ),
      ),
    },
    instanceId,
    NodePath.join(root, "state"),
    (options: OmpRpcProcessOptions) =>
      Effect.sync(() => {
        extension = makeFakeOmpModelsExtension(options);
        return fakeNative(extension);
      }),
    input.timing,
    waitSnapshots,
  );
  const client = yield* factory({ target: ompTarget, command: "fake-omp", env: { PATH: "" } });
  if (!extension) throw new Error("fake process was not launched");
  const loaded = extension;
  yield* Effect.addFinalizer(() => Effect.sync(() => loaded.stop()));
  if (input.watch) yield* Effect.promise(() => loaded.start());
  else yield* Effect.promise(() => loaded.refresh());
  const changeSettings = Effect.fn("test.OmpCustomModels.changeSettings")(function* (
    next: ReadonlyArray<ResolvedModelConnection>,
    revision?: number,
  ) {
    state.current = next;
    const snapshot = {
      customModels: { revision: revision ?? state.resolutions + 100, connections: [] },
    } as unknown as ServerSettings;
    const processed = Promise.withResolvers<void>();
    processedSettings.set(snapshot, processed.resolve);
    yield* Queue.offer(settingsChanges, snapshot);
    yield* Effect.promise(() => processed.promise);
  });
  return { client, extension: loaded, state, changeSettings, waitSnapshots };
});
