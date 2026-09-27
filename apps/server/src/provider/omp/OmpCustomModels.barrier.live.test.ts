// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { ResolvedModelConnection } from "../../customModels.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary } from "./OmpLive.testFixtures.ts";
import { ompModelToServerModel } from "./OmpModel.ts";
import { OMP_ISOLATED_ARGS } from "./OmpRpcProcess.ts";

/**
 * The second reviewer's live probes (R2-9, R2-10), against a real `omp`.
 * Opt in with OMP_QUALIFY_BINARY. Each run uses a temporary HOME and agent
 * directory, a synthetic key, and blocks non-loopback egress; no model is
 * prompted, so no provider is contacted.
 */
const binary = ompQualifyBinary;
const instanceId = ProviderInstanceId.make("omp-custom-model-live");

const connection: ResolvedModelConnection = {
  id: "local-test",
  name: "Local test",
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
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
      reasoningOverride: { supported: true, levels: ["low", "medium", "high"] },
      instanceIds: [instanceId],
    },
  ],
  apiKey: Redacted.make("synthetic-local-key"),
};

const liveEnvironment = (root: string) =>
  ompLiveInstance(root, { blockEgress: true, baseEnv: { PATH: process.env.PATH ?? "" } })
    .environment;

/** Roots made by the current test, removed after it whether it passed or not. */
const roots: Array<string> = [];
const makeRoot = (label: string) => {
  const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-barrier-live-${process.pid}-${label}`);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe.runIf(binary)("real Oh My Pi custom-model refresh barrier", () => {
  it.effect(
    "R2-9: a newly added model is listed without an explicit refresh",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = makeRoot("r2-9");
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
          const factory = yield* makeOmpCustomModelsClientFactory(
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
          const launch = {
            command: binary!,
            cwd: root,
            env: liveEnvironment(root),
            extraArgs: [...OMP_ISOLATED_ARGS],
            sessionDir: NodePath.join(root, "session"),
          };
          let client = yield* factory(launch);
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
          const secondModel = {
            ...connection.models[0]!,
            id: "qualification-model-2",
            modelId: "qwen3.6:35b-a3b",
            name: "Second qualification model",
          };
          currentConnections = [{ ...connection, models: [...connection.models, secondModel] }];
          yield* notifySettingsChange;
          // No /scient-models-refresh and no refreshModels(): the barrier alone.
          expect((yield* client.getModels()).models).toContainEqual(
            expect.objectContaining({ provider: "scient_local-test", id: "qwen3.6:35b-a3b" }),
          );
          yield* client.setModel("scient_local-test", "qwen3.6:35b-a3b");
          expect((yield* client.getState()).model).toMatchObject({
            provider: "scient_local-test",
            id: "qwen3.6:35b-a3b",
          });
          currentConnections = [connection];
          yield* notifySettingsChange;
          expect(yield* client.getModels().pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
          yield* client.close();
          client = yield* factory(launch);
          expect((yield* client.getModels()).models).toContainEqual(
            expect.objectContaining({ provider: "scient_local-test", id: "gemma4:12b-it-qat" }),
          );
          yield* client.setModel("scient_local-test", "gemma4:12b-it-qat");
          expect((yield* client.getState()).model).toMatchObject({
            provider: "scient_local-test",
            id: "gemma4:12b-it-qat",
          });
          const exit = yield* client.shutdown;
          // The extension's long-poll does not keep the process alive.
          expect(exit.forced).toBe(false);
          yield* client.close();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    120_000,
  );

  it.effect(
    "R2-10: the configured low/medium/high reasoning choices are preserved",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = makeRoot("r2-10");
          const factory = yield* makeOmpCustomModelsClientFactory(
            {
              resolveCustomModels: () => Effect.succeed([connection]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          const client = yield* factory({
            command: binary!,
            cwd: root,
            env: liveEnvironment(root),
            extraArgs: [...OMP_ISOLATED_ARGS],
            sessionDir: NodePath.join(root, "session"),
          });
          const models = yield* client.getModels();
          const discovered = models.models.find((model) => model.provider === "scient_local-test");
          if (!discovered) throw new Error("custom model not discovered");
          const projected = ompModelToServerModel(discovered);
          yield* client.shutdown;
          yield* client.close();
          const descriptor = projected?.capabilities?.optionDescriptors?.[0];
          expect(
            descriptor && "options" in descriptor
              ? descriptor.options.map((option) => option.id)
              : [],
          ).toEqual(["low", "medium", "high"]);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    120_000,
  );
});
