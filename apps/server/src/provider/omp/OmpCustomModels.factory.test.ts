// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { ResolvedModelConnection } from "../../customModels.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import {
  consumeOmpModelsBootstrap,
  makeFakeOmpModelsExtension,
} from "./OmpCustomModelsTestHelpers.ts";
import type { OmpRpcProcess, OmpRpcProcessOptions } from "./OmpRpcProcess.ts";
import { ompTarget } from "./OmpTarget.ts";

const instanceId = ProviderInstanceId.make("omp-factory-test");
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
  credentialId: "credential",
  apiKey: Redacted.make("secret-value"),
  models: [model],
};

const response = (command: string, data: unknown = {}) => ({
  id: "factory-test",
  type: "response" as const,
  command,
  success: true,
  data,
});

const responseStatus = (url: string, init?: RequestInit) =>
  // @effect-diagnostics-next-line globalFetchInEffect:off
  Effect.promise(() => fetch(url, init).then((result) => result.status));

const fakeProcess = (
  options: OmpRpcProcessOptions,
  prompts: string[],
  shutdowns: { count: number },
  extensions: Array<ReturnType<typeof makeFakeOmpModelsExtension>>,
): OmpRpcProcess => {
  const extension = makeFakeOmpModelsExtension(options);
  extensions.push(extension);
  return {
    version: "18.2.8",
    ready: Effect.succeed({
      type: "ready" as const,
      protocolVersion: 1 as const,
      supportedProtocolVersions: [1 as const, 2 as const],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    }),
    events: Stream.empty,
    flushEvents: () => Effect.void,
    prompt: (input: { readonly message: string }) =>
      Effect.sync(() => {
        prompts.push(input.message);
        return response("prompt", { agentInvoked: false });
      }),
    getModels: () =>
      Effect.sync(() => ({
        models: extension.models().map(({ provider, id, name }) => ({ provider, id, name })),
      })),
    close: () => Effect.void,
    shutdown: Effect.sync(() => {
      shutdowns.count += 1;
      return { code: 0, forced: false, stderrTail: "" };
    }),
  } as unknown as OmpRpcProcess;
};

it.effect(
  "passes only an authenticated endpoint and extension path to the OMP child",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-factory-${process.pid}`);
        NodeFS.rmSync(root, { recursive: true, force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        NodeFS.mkdirSync(root, { recursive: true });
        let current: ReadonlyArray<ResolvedModelConnection> = [connection];
        const settingsChanges = yield* Queue.unbounded<ServerSettings>();
        const resolutionEvents = yield* Queue.unbounded<void>();
        const drainResolutionEvents = Effect.gen(function* () {
          while (true) {
            const next = yield* Queue.poll(resolutionEvents);
            if (Option.isNone(next)) return;
          }
        });
        const notifySettingsChange = Effect.gen(function* () {
          yield* drainResolutionEvents;
          yield* Queue.offer(settingsChanges, {} as ServerSettings);
          yield* Queue.take(resolutionEvents);
        });
        const prompts: string[] = [];
        const shutdowns = { count: 0 };
        const extensions: Array<ReturnType<typeof makeFakeOmpModelsExtension>> = [];
        let captured: OmpRpcProcessOptions | undefined;
        const factory = yield* makeOmpCustomModelsClientFactory(
          ompTarget,
          {
            resolveCustomModels: () =>
              Effect.gen(function* () {
                yield* Queue.offer(resolutionEvents, undefined);
                return current;
              }),
            subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
          },
          instanceId,
          NodePath.join(root, "state"),
          (options) =>
            Effect.sync(() => {
              captured = options;
              return fakeProcess(options, prompts, shutdowns, extensions);
            }),
        );
        const client = yield* factory({
          target: ompTarget,
          command: "fake-omp",
          env: { PATH: "" },
        });
        const extension = extensions[0];
        if (!extension) throw new Error("fake extension was not started");
        yield* Effect.promise(() => extension.start());
        const launch = captured;
        if (!launch) throw new Error("fake process was not launched");
        const { url, headers } = extension;
        // The endpoint, its token and the key reach OMP only through the
        // bootstrap the fake extension consumed, never the environment.
        expect(Object.keys(launch.env ?? {}).filter((name) => name.startsWith("SCIENT_"))).toEqual(
          [],
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.stringify(launch.env)).not.toContain("secret-value");
        expect(launch.extraArgs?.slice(-2)).toEqual([
          "--extension",
          expect.stringContaining("scient-custom-models.mjs"),
        ]);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.stringify(launch.extraArgs)).not.toContain("secret-value");
        expect(yield* responseStatus(url)).toBe(403);
        expect(yield* responseStatus(url, { headers })).toBe(200);
        expect((yield* client.getModels()).models).toContainEqual({
          provider: "scient_local",
          id: "local-model",
          name: "Local model",
        });
        const extensionPath = launch.extraArgs?.at(-1);
        if (!extensionPath) throw new Error("custom-model extension path was not configured");
        expect(yield* fs.readFileString(extensionPath)).not.toContain("secret-value");

        const secondModel = { ...model, id: "second", modelId: "second-model" };
        current = [{ ...connection, models: [...connection.models, secondModel] }];
        yield* notifySettingsChange;
        expect((yield* client.getModels()).models).toContainEqual({
          provider: "scient_local",
          id: "second-model",
          name: "Local model",
        });
        expect(prompts).toEqual([]);
        current = [
          { ...connection, models: [...connection.models, secondModel], name: "Renamed local" },
        ];
        yield* notifySettingsChange;
        yield* client.getModels();
        expect(prompts).toEqual([]);

        const currentConnection = current[0]!;
        current = [currentConnection, { ...connection, id: "new-keyed", name: "New keyed" }];
        yield* notifySettingsChange;
        const beforeNewConnection = shutdowns.count;
        expect((yield* client.getModels()).models).not.toContainEqual(
          expect.objectContaining({ provider: "scient_new-keyed" }),
        );
        expect(shutdowns.count).toBe(beforeNewConnection);
        current = [currentConnection];
        yield* notifySettingsChange;

        current = [{ ...connection, credentialId: "rotated", apiKey: Redacted.make("new-secret") }];
        yield* notifySettingsChange;
        expect(yield* client.getModels().pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
        expect(shutdowns.count).toBe(1);
        extension.stop();
        yield* client.close();
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
  30_000,
);

it.effect(
  "reports a key Oh My Pi would run as a command as a credential error and never passes it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-command-key-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const commandKey = { ...connection, apiKey: Redacted.make("!cat ~/.ssh/id_rsa") };
        const settingsChanges = yield* Queue.unbounded<ServerSettings>();
        let bootstrap: ReturnType<typeof consumeOmpModelsBootstrap> | undefined;
        const factory = yield* makeOmpCustomModelsClientFactory(
          ompTarget,
          {
            resolveCustomModels: () => Effect.succeed([commandKey]),
            subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
          },
          instanceId,
          NodePath.join(root, "state"),
          (options) =>
            Effect.sync(() => {
              bootstrap = consumeOmpModelsBootstrap(options);
              return {
                ready: Effect.never,
                close: () => Effect.void,
                shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
              } as unknown as OmpRpcProcess;
            }),
        );
        const client = yield* factory({
          target: ompTarget,
          command: "fake-omp",
          env: { PATH: "" },
        });

        expect(bootstrap?.keys).toEqual({});
        expect(client.modelProviderLabel?.("scient_local")).toBe("Local");
        expect(client.modelProviderLabel?.("anthropic")).toBeUndefined();
        expect(client.assessModelConnections?.([])).toEqual([
          expect.objectContaining({
            connectionId: "local",
            state: "needs_setup",
            reason: "credential",
          }),
        ]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
);
