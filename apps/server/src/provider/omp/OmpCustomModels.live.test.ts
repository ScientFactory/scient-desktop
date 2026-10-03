// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { OMP_ISOLATED_ARGS } from "./OmpRpcProcess.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import {
  ompLiveInstance,
  ompQualifyBinary,
  ompQualifyLogsDir,
  ompQualifyTarget,
} from "./OmpLive.testFixtures.ts";

const binary = ompQualifyBinary ?? "";

const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Every file under `root` whose text contains `needle`, relative to `root`. */
const filesContaining = (root: string, needle: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = NodePath.join(entry.parentPath, entry.name);
    return NodeFS.readFileSync(file, "utf8").includes(needle)
      ? [NodePath.relative(root, file)]
      : [];
  });

/** The production environment builder over a hermetic base, egress blocked. */
const liveInstance = (root: string) =>
  ompLiveInstance(root, { blockEgress: true, baseEnv: { PATH: process.env.PATH ?? "" } });

describe.runIf(ompQualifyBinary)("real Oh My Pi custom model qualification", () => {
  it.effect(
    "loads a Scient custom model through an isolated OMP extension",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-custom-model-${process.pid}`);
          NodeFS.rmSync(root, { recursive: true, force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          NodeFS.mkdirSync(root, { recursive: true });
          const connection: ResolvedModelConnection = {
            id: "local-test",
            name: "Local test",
            protocol: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            credentialId: "qualification-key",
            models: [
              {
                id: "qualification-model",
                modelId: "gemma4:12b-it-qat",
                name: "Qualification model",
                configurationMode: "manual",
                contextWindow: 262144,
                maxOutputTokens: 32768,
                images: true,
                reasoning: true,
                reasoningOverride: {
                  supported: true,
                  levels: ["low", "medium", "high"],
                },
                instanceIds: [ProviderInstanceId.make("omp-custom-model-live")],
              },
            ],
            apiKey: Redacted.make("synthetic-local-key"),
          };
          let currentConnections: ReadonlyArray<ResolvedModelConnection> = [connection];
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
          const instanceId = ProviderInstanceId.make("omp-custom-model-live");
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () =>
                Effect.gen(function* () {
                  yield* Queue.offer(resolutionEvents, undefined);
                  return currentConnections;
                }),
              subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          let client = yield* factory({
            target: ompQualifyTarget,
            command: binary,
            cwd: root,
            env: liveInstance(root).environment,
            extraArgs: [...OMP_ISOLATED_ARGS],
            sessionDir: NodePath.join(root, "session"),
          });
          const models = yield* client.getModels();
          expect(models.models).toContainEqual(
            expect.objectContaining({ provider: "scient_local-test", id: "gemma4:12b-it-qat" }),
          );
          expect(client.assessModelConnections?.(models.models)).toContainEqual(
            expect.objectContaining({
              connectionId: "local-test",
              modelId: "qualification-model",
              state: "available",
              contextWindow: 262144,
              maxOutputTokens: 32768,
            }),
          );
          const commands = yield* client.getCommands();
          expect(commands.commands).toContainEqual(
            expect.objectContaining({ name: "scient-models-refresh" }),
          );
          const secondModel = {
            ...connection.models[0]!,
            id: "qualification-model-2",
            modelId: "qwen3.6:35b-a3b",
            name: "Second qualification model",
          };
          currentConnections = [{ ...connection, models: [...connection.models, secondModel] }];
          yield* notifySettingsChange;
          expect((yield* client.getModels()).models).toContainEqual(
            expect.objectContaining({
              provider: "scient_local-test",
              id: "qwen3.6:35b-a3b",
            }),
          );
          currentConnections = [connection];
          yield* notifySettingsChange;
          expect(yield* client.getModels().pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
          yield* client.close();
          client = yield* factory({
            target: ompQualifyTarget,
            command: binary,
            cwd: root,
            env: liveInstance(root).environment,
            extraArgs: [...OMP_ISOLATED_ARGS],
            sessionDir: NodePath.join(root, "session"),
          });
          expect((yield* client.getModels()).models).toContainEqual(
            expect.objectContaining({ provider: "scient_local-test", id: "gemma4:12b-it-qat" }),
          );
          yield* client.setModel("scient_local-test", "gemma4:12b-it-qat");
          expect((yield* client.getState()).model).toMatchObject({
            provider: "scient_local-test",
            id: "gemma4:12b-it-qat",
          });
          const terminal = yield* Deferred.make<void>();
          yield* client.events.pipe(
            Stream.runForEach((event) =>
              event._tag === "Event" && event.event.type === "agent_end"
                ? Deferred.succeed(terminal, undefined)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* client.prompt({ message: "Reply with exactly CUSTOM_MODEL_OK." });
          yield* Deferred.await(terminal).pipe(Effect.timeout("60 seconds"));
          yield* client.shutdown;
          yield* client.close();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    120_000,
  );

  it.effect(
    "registers every shared OMP API format without contacting the endpoint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-custom-formats-${process.pid}`);
          NodeFS.rmSync(root, { recursive: true, force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          NodeFS.mkdirSync(root, { recursive: true });
          const instanceId = ProviderInstanceId.make("omp-custom-formats-live");
          const protocols = [
            ["completions", "openai-completions"],
            ["responses", "openai-responses"],
            ["messages", "anthropic-messages"],
          ] as const;
          const connections: ReadonlyArray<ResolvedModelConnection> = protocols.map(
            ([id, protocol]) => ({
              id,
              name: `${id} connection`,
              protocol,
              baseUrl: "http://127.0.0.1:11434/v1",
              credentialId: null,
              apiKey: null,
              models: [
                {
                  id: `${id}-model`,
                  modelId: `${id}-model`,
                  name: `${id} model`,
                  configurationMode: "manual",
                  contextWindow: 32_000,
                  maxOutputTokens: 2_048,
                  images: false,
                  reasoning: false,
                  instanceIds: [instanceId],
                },
              ],
            }),
          );
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () => Effect.succeed(connections),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          const client = yield* factory({
            target: ompQualifyTarget,
            command: binary,
            cwd: root,
            env: liveInstance(root).environment,
            extraArgs: [...OMP_ISOLATED_ARGS],
            sessionDir: NodePath.join(root, "session"),
          });
          const models = yield* client.getModels();
          for (const [id] of protocols) {
            expect(models.models).toContainEqual(
              expect.objectContaining({ provider: `scient_${id}`, id: `${id}-model` }),
            );
          }
          yield* client.shutdown;
          yield* client.close();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    120_000,
  );

  it.effect(
    "keeps a custom-model key an endpoint echoes out of adapter events and the native log",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-custom-echo-${process.pid}`);
          NodeFS.rmSync(root, { recursive: true, force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          NodeFS.mkdirSync(root, { recursive: true });
          // Not key-shaped, so only the process's exact secret list can catch it.
          const key = "customlivekey-0123456789abcdef";
          // An OpenAI-compatible endpoint that rejects the key and echoes it.
          const server = NodeHttp.createServer((request, response) => {
            request.resume();
            request.on("end", () => {
              response.writeHead(401, { "content-type": "application/json" }).end(
                toJson({
                  error: {
                    message: `Incorrect API key provided: ${key}`,
                    type: "invalid_request_error",
                    code: "invalid_api_key",
                  },
                }),
              );
            });
          });
          const port = yield* Effect.acquireRelease(
            Effect.callback<number>((resume) => {
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                resume(Effect.succeed(typeof address === "object" && address ? address.port : 0));
              });
            }),
            () =>
              Effect.callback<void>((resume) => {
                server.close(() => resume(Effect.void));
              }),
          );
          const instanceId = ProviderInstanceId.make("omp-custom-echo-live");
          const connection: ResolvedModelConnection = {
            id: "echo",
            name: "Echoing endpoint",
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            credentialId: "echo-key",
            apiKey: Redacted.make(key),
            models: [
              {
                id: "echo-model",
                modelId: "echo-model",
                name: "Echo model",
                configurationMode: "manual",
                contextWindow: 32_000,
                maxOutputTokens: 2_048,
                images: false,
                reasoning: false,
                instanceIds: [instanceId],
              },
            ],
          };
          const stateDir = NodePath.join(root, "state");
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () => Effect.succeed([connection]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            stateDir,
          );
          const logged: Array<unknown> = [];
          const { environment, homePath } = liveInstance(root);
          const adapter = yield* makeOmpAdapter({
            target: ompQualifyTarget,
            binaryPath: binary,
            providerInstanceId: instanceId,
            stateDir,
            attachmentsDir: NodePath.join(root, "attachments"),
            environment,
            homePath,
            makeProcess: factory,
            nativeEventLogger: {
              filePath: "/dev/null",
              write: (event) =>
                Effect.sync(() => {
                  logged.push(event);
                }),
              close: () => Effect.void,
            },
          });
          const events: Array<ProviderRuntimeEvent> = [];
          const terminal = yield* Deferred.make<void>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => events.push(event)).pipe(
                Effect.andThen(
                  event.type === "turn.completed" || event.type === "turn.aborted"
                    ? Deferred.succeed(terminal, undefined)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkScoped,
          );
          const threadId = ThreadId.make("omp-custom-echo-thread");
          yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
          yield* adapter.sendTurn({
            threadId,
            input: "Say hello.",
            modelSelection: createModelSelection(instanceId, "scient_echo/echo-model"),
          });
          yield* Deferred.await(terminal).pipe(Effect.timeout("60 seconds"));
          const sessions = yield* adapter.listSessions();
          yield* adapter.stopAll();

          const completed = events.find((event) => event.type === "turn.completed");
          expect(completed?.payload).toMatchObject({ state: "failed" });
          expect(toJson(completed?.payload)).toContain("Incorrect API key provided: [REDACTED]");
          expect(logged.length).toBeGreaterThan(0);
          expect(toJson(events)).not.toContain(key);
          expect(toJson(logged)).not.toContain(key);
          expect(toJson(sessions)).not.toContain(key);
          // Oh My Pi 18.3.1 itself writes the provider's error, key included,
          // to its log under HOME and to the session transcript. Scient cannot
          // redact those (docs/user/providers-omp.md); no other file holds it,
          // including a leftover bootstrap.
          expect(
            filesContaining(root, key).filter(
              (file) =>
                !file.startsWith(ompQualifyLogsDir) &&
                !(
                  file.startsWith(
                    NodePath.join("state", `${ompQualifyTarget.stateNamespace}-sessions`),
                  ) && file.endsWith(".jsonl")
                ),
            ),
          ).toEqual([]);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    120_000,
  );

  it.effect(
    "uses a Scient custom model through the OMP adapter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-custom-adapter-${process.pid}`);
          NodeFS.rmSync(root, { recursive: true, force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          NodeFS.mkdirSync(root, { recursive: true });
          const instanceId = ProviderInstanceId.make("omp-custom-adapter-live");
          const connection: ResolvedModelConnection = {
            id: "local-adapter",
            name: "Local adapter",
            protocol: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            credentialId: null,
            apiKey: null,
            models: [
              {
                id: "adapter-model",
                modelId: "gemma4:12b-it-qat",
                name: "Adapter model",
                configurationMode: "manual",
                contextWindow: 262144,
                maxOutputTokens: 32768,
                images: true,
                reasoning: true,
                reasoningOverride: { supported: true, levels: ["low", "medium", "high"] },
                instanceIds: [instanceId],
              },
            ],
          };
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () => Effect.succeed([connection]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          const { environment, homePath } = liveInstance(root);
          const adapter = yield* makeOmpAdapter({
            target: ompQualifyTarget,
            binaryPath: binary,
            providerInstanceId: instanceId,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment,
            homePath,
            makeProcess: factory,
          });
          const threadId = ThreadId.make("omp-custom-adapter-thread");
          yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
          const terminal = yield* Deferred.make<void>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              event.type === "turn.completed" || event.type === "turn.aborted"
                ? Deferred.succeed(terminal, undefined)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* adapter.sendTurn({
            threadId,
            input: "Reply with exactly CUSTOM_ADAPTER_OK.",
            modelSelection: createModelSelection(
              instanceId,
              "scient_local-adapter/gemma4:12b-it-qat",
            ),
          });
          yield* Deferred.await(terminal).pipe(Effect.timeout("60 seconds"));
          yield* adapter.stopAll();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    180_000,
  );
});
