import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import { parsePiModelSlug } from "./PiRpc.ts";
import { encodePiModelSlug } from "../../provider/pi/PiModel.ts";
import { makePiCustomModelsConnectionFactory } from "../../provider/pi/PiCustomModelsConnection.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as PubSub from "effect/PubSub";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  testLayer,
  PI_INSTANCE_ID,
  THREAD_ID,
  SESSION_ID,
  FAKE_SESSION_FILE,
  runtimePolicy,
  modelSelection,
  makeFakePi,
  makeAdapter,
  openRuntime,
  startTurn,
} from "./PiAdapterV2.fixture.ts";

describe("PiAdapterV2", () => {
  it.effect(
    "uses instance-scoped custom-model metadata and blocks a later prompt after revocation",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const http = yield* HttpClient.HttpClient;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const requestedInstances: string[] = [];
        const connection: ResolvedModelConnection = {
          id: "fixture",
          name: "Fixture",
          baseUrl: "https://example.test/v1",
          protocol: "openai-completions",
          credentialId: "synthetic-key-id",
          apiKey: Redacted.make("synthetic-key"),
          models: [
            {
              id: "selected",
              modelId: "model/with slash",
              name: "Selected",
              contextWindow: 32000,
              maxOutputTokens: 8192,
              images: false,
              reasoning: true,
              reasoningMetadata: {
                status: "known",
                source: "manual",
                checkedAt: "2026-01-01T00:00:00.000Z",
                stale: false,
                supported: true,
                levels: ["off", "high"],
                defaultLevel: "off",
              },
              instanceIds: [PI_INSTANCE_ID],
            },
          ],
        };
        let connections = [connection];
        const snapshot = () => ({
          ...DEFAULT_SERVER_SETTINGS,
          customModels: { revision: 0, connections },
        });
        const updates = yield* PubSub.unbounded<ReturnType<typeof snapshot>>();
        fake.onSpawn((env) =>
          http
            .get(env.SCIENT_PI_MODELS_URL!, {
              headers: { authorization: "Bearer " + env.SCIENT_PI_MODELS_TOKEN! },
            })
            .pipe(
              Effect.flatMap((response) => response.text),
              Effect.asVoid,
              Effect.orDie,
            ),
        );
        fake.queueCommands({ commands: [{ name: "scient-models-refresh", source: "extension" }] });
        const makeConnection = yield* makePiCustomModelsConnectionFactory(
          {
            getSettings: Effect.sync(snapshot),
            resolveCustomModels: (instanceId) =>
              Effect.sync(() => {
                requestedInstances.push(instanceId);
                return connections;
              }),
            subscribeChanges: PubSub.subscribe(updates).pipe(Effect.map(Stream.fromSubscription)),
          },
          PI_INSTANCE_ID,
          serverConfig.stateDir,
        );
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          makeConnection,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        // Raw Pi says high is inherited; Scient's annotated default is off.
        const selection = {
          instanceId: PI_INSTANCE_ID,
          model: encodePiModelSlug("scient_fixture", "model/with slash")!,
          options: [{ id: "thinkingLevel", value: "default" }],
        };
        yield* startTurn(runtime, providerThread, "default", [], "First custom prompt", selection);
        assert.equal((yield* fake.takeRequest("set_thinking_level")).level, "off");
        assert.isTrue(
          requestedInstances.length > 0 && requestedInstances.every((id) => id === PI_INSTANCE_ID),
        );
        assert.isTrue(fake.lastSpawn().args.includes("--extension"));
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        connections = [];
        yield* PubSub.publish(updates, snapshot());
        const result = yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          "Revoked custom prompt",
          selection,
          2,
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(
          fake
            .allRequests()
            .some(
              (request) => request.type === "prompt" && request.message === "Revoked custom prompt",
            ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(testLayer.pipe(Layer.provideMerge(FetchHttpClient.layer))),
      ),
  );

  it.effect("leaves the native default model and effort untouched when neither is overridden", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({ model: { provider: "xai", id: "grok-4.6" }, thinkingLevel: "off" });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default");
      assert.isFalse(
        fake
          .allRequests()
          .some((request) => request.type === "set_model" || request.type === "set_thinking_level"),
      );
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "decodes canonical special-character models and confirms explicit thinkingLevel off",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const slug = encodePiModelSlug("provider/name%", "models/name with spaces%");
        assert.isDefined(slug);
        assert.deepEqual(parsePiModelSlug(slug!), {
          provider: "provider/name%",
          modelId: "models/name with spaces%",
        });
        assert.isNull(parsePiModelSlug("provider/models/name with spaces%"));
        yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
          instanceId: PI_INSTANCE_ID,
          model: slug!,
          options: [{ id: "thinkingLevel", value: "off" }],
        });
        const selected = yield* fake.takeRequest("set_model");
        assert.equal(selected.provider, "provider/name%");
        assert.equal(selected.modelId, "models/name with spaces%");
        assert.equal((yield* fake.takeRequest("set_thinking_level")).level, "off");
        assert.isTrue(
          fake.allRequests().some((request) => request.type === "get_available_thinking_levels"),
        );
        yield* fake.takeRequest("prompt");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses prompt delivery when native state does not confirm the requested model", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ model: { provider: "different", id: "model" } });
      const result = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        modelSelection("xai/grok-4.6"),
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "refuses prompt delivery when native state substitutes an explicit thinking level",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.queueState({ thinkingLevel: "high" });
        const result = yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
          instanceId: PI_INSTANCE_ID,
          model: "xai/grok-4.6",
          options: [{ id: "thinkingLevel", value: "off" }],
        }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resets applied thinking when returning to Pi default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        model: { provider: "xai", id: "grok-4.6" },
        thinkingLevel: "medium",
        sessionFile: FAKE_SESSION_FILE,
        sessionId: "abc",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      // An explicit effort on a concrete model.
      yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
        instanceId: PI_INSTANCE_ID,
        model: "xai/grok-4.6",
        options: [{ id: "thinking", value: "high" }],
      });
      const modelRequest = yield* fake.takeRequest("set_model");
      assert.equal(modelRequest["provider"], "xai");
      assert.equal(modelRequest["modelId"], "grok-4.6");
      const levelRequest = yield* fake.takeRequest("set_thinking_level");
      assert.equal(levelRequest["level"], "high");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      // Back to Pi default with no explicit thinking choice of its own.
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        {
          instanceId: PI_INSTANCE_ID,
          model: "default",
        },
        2,
      );
      const replayModel = yield* fake.takeRequest("set_model");
      assert.equal(replayModel["provider"], "xai");
      assert.equal(replayModel["modelId"], "grok-4.6");
      const resetLevel = yield* fake.takeRequest("set_thinking_level");
      assert.equal(resetLevel["level"], "medium");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps native Pi usable after unsupported thinking validation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const invalid = yield* startTurn(runtime, providerThread, "default", [], "invalid", {
        ...modelSelection("xai/grok-4.6"),
        options: [{ id: "thinkingLevel", value: "impossible" }],
      }).pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 0);
      assert.isFalse(observed.some((event) => event.type === "provider_turn.updated"));
      yield* startTurn(runtime, providerThread, "xai/grok-4.6");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      assert.isTrue(
        (yield* takeEvent((event) => event.type === "turn.terminal")).type === "turn.terminal",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects unsupported Pi automatic mode before native spawn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      let spawned = false;
      fake.onSpawn(() =>
        Effect.sync(() => {
          spawned = true;
        }),
      );
      const adapter = yield* makeAdapter(fake);
      const result = yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy: { ...runtimePolicy, runtimeMode: "auto" },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(spawned);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
