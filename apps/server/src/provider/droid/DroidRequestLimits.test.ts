// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off -- The stand-in Droid calls its broker over plain HTTP, as Droid does.
import * as NodeFS from "node:fs";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { DroidAcpRuntimeInput } from "../acp/DroidAcpSupport.ts";
import { makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";

const instanceId = ProviderInstanceId.make("droid_limits");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeOverlay = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      customModels: Schema.Array(
        Schema.Struct({ baseUrl: Schema.String, apiKey: Schema.String, model: Schema.String }),
      ),
    }),
  ),
);

/** A model API whose every response ends the way `finish` says. */
async function startModelApi(finish: () => string) {
  let requests = 0;
  const authorizations: Array<string | undefined> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    for await (const _chunk of request);
    requests++;
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: finish() }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests: () => requests,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** One model request as Droid sends it: to the broker route, with the capability. */
async function requestModel(overlay: { baseUrl: string; apiKey: string; model: string }) {
  const response = await fetch(`${overlay.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${overlay.apiKey}` },
    body: JSON.stringify({ model: overlay.model, stream: true }),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Stands in for Droid's agent loop: it keeps asking the model to continue
 * until the broker refuses, then waits for Scient to cancel the prompt.
 */
const makeLoopingDroid = (maxRequests: number, beforeRequest: () => void = () => undefined) => {
  const cancelled = Deferred.makeUnsafe<void>();
  let cancels = 0;
  let requests = 0;
  const factory = (input: DroidAcpRuntimeInput) =>
    Effect.gen(function* () {
      // Closing the runtime ends the Droid process, and with it any prompt.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Deferred.doneUnsafe(cancelled, Effect.void)),
      );
      const overlay = decodeOverlay(NodeFS.readFileSync(input.runtimeSettingsPath!, "utf8"))
        .customModels[0]!;
      const runtime = {
        prompt: () =>
          Effect.gen(function* () {
            for (let index = 0; index < maxRequests; index++) {
              requests++;
              beforeRequest();
              const reply = yield* Effect.promise(() => requestModel(overlay));
              // Droid ends its turn when the API refuses it, but only after Scient cancels.
              if (reply.status !== 200) {
                yield* Deferred.await(cancelled);
                return { stopReason: "cancelled" as const };
              }
              if (reply.text.includes('"finish_reason":"stop"')) break;
            }
            return { stopReason: "end_turn" as const };
          }),
        cancel: Effect.sync(() => {
          cancels++;
          Deferred.doneUnsafe(cancelled, Effect.void);
        }),
      };
      return runtime as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
    });
  return { factory, cancels: () => cancels, requests: () => requests };
};

const fixture = (origin: string) => {
  const connections: ReadonlyArray<ResolvedModelConnection> = [
    {
      id: "limits",
      name: "Limits",
      protocol: "openai-completions",
      baseUrl: origin,
      credentialId: "limits-key",
      apiKey: Redacted.make("limits-real-key-0123456789"),
      models: [
        {
          id: "fixture",
          modelId: "vendor/fixture",
          name: "Fixture",
          images: false,
          reasoning: false,
          instanceIds: [instanceId],
        },
      ],
    },
  ];
  return {
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      customModels: { revision: 0, connections },
    }),
    committedCustomModels: () => ({ revision: 0, connections }),
    resolveCustomModels: () => Effect.succeed(connections),
    subscribeChanges: Effect.succeed(Stream.never),
  };
};

const runtimeInput: DroidAcpRuntimeInput = {
  childProcessSpawner: {} as never,
  droidSettings: { binaryPath: "droid" },
  cwd: "/tmp/project",
  clientInfo: { name: "test", version: "0" },
};

describe("Droid per-turn request limits", () => {
  it.effect(
    "ends a truncation loop as a token-limit stop and cancels the Droid prompt",
    () =>
      Effect.gen(function* () {
        let truncate = true;
        const api = yield* Effect.promise(() =>
          startModelApi(() => (truncate ? "length" : "stop")),
        );
        yield* Effect.addFinalizer(() => Effect.promise(api.close));
        const droid = makeLoopingDroid(10_000);
        const factory = yield* makeDroidCustomModelsRuntimeFactory(
          fixture(api.origin),
          instanceId,
          droid.factory,
        );
        const runtime = yield* factory(runtimeInput);
        const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "go" }] });
        expect(result.stopReason).toBe("max_tokens");
        expect(droid.cancels()).toBe(1);
        expect(api.requests()).toBe(5);
        expect(runtime.requestLimitBreach?.()).toMatchObject({ reason: "truncated-responses" });
        expect(runtime.requestLimitBreach?.()?.message).toContain("output limit 5 times in a row");

        // The next turn starts with a fresh budget.
        truncate = false;
        yield* runtime.beginTurn!;
        const next = yield* runtime.prompt({ prompt: [{ type: "text", text: "again" }] });
        expect(next.stopReason).toBe("end_turn");
        expect(runtime.requestLimitBreach?.()).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    20_000,
  );

  it.effect("reports the first retryable upstream error of a turn, once per turn", () =>
    Effect.gen(function* () {
      // Droid retries 429 and 5xx answers itself and shows nothing meanwhile.
      const statuses = [429, 503, 200];
      const server = NodeHttp.createServer(async (request, response) => {
        for await (const _chunk of request);
        const status = statuses.shift() ?? 200;
        if (status !== 200) {
          response.writeHead(status, { "content-type": "application/json" });
          response.end('{"error":{"message":"busy"}}');
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      let overlay: { baseUrl: string; apiKey: string; model: string } | undefined;
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture(origin),
        instanceId,
        (input) =>
          Effect.sync(() => {
            overlay = decodeOverlay(NodeFS.readFileSync(input.runtimeSettingsPath!, "utf8"))
              .customModels[0]!;
            return {} as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
          }),
      );
      const runtime = yield* factory(runtimeInput);
      yield* runtime.beginTurn!;
      const retrying = yield* runtime.upstreamRetrying!.pipe(Effect.forkChild);
      expect((yield* Effect.promise(() => requestModel(overlay!))).status).toBe(429);
      expect((yield* Effect.promise(() => requestModel(overlay!))).status).toBe(503);
      expect((yield* Effect.promise(() => requestModel(overlay!))).status).toBe(200);
      expect(yield* Fiber.join(retrying)).toBe(429);
      // A new turn waits for its own.
      yield* runtime.beginTurn!;
      const next = yield* runtime.upstreamRetrying!.pipe(Effect.forkChild);
      expect((yield* Effect.promise(() => requestModel(overlay!))).status).toBe(200);
      yield* Effect.yieldNow;
      expect(next.pollUnsafe()).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a breached budget for the rest of its turn, including a steer", () =>
    Effect.gen(function* () {
      let truncate = true;
      const api = yield* Effect.promise(() => startModelApi(() => (truncate ? "length" : "stop")));
      yield* Effect.addFinalizer(() => Effect.promise(api.close));
      const droid = makeLoopingDroid(10_000);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture(api.origin),
        instanceId,
        droid.factory,
      );
      const runtime = yield* factory(runtimeInput);
      yield* runtime.beginTurn!;
      expect((yield* runtime.prompt({ prompt: [{ type: "text", text: "go" }] })).stopReason).toBe(
        "max_tokens",
      );
      // A follow-up the adapter folds into the same turn: no new budget.
      truncate = false;
      const steer = yield* runtime.prompt({ prompt: [{ type: "text", text: "and more" }] });
      expect(steer.stopReason).toBe("max_tokens");
      expect(api.requests()).toBe(5);
      // Only a new turn starts over.
      yield* runtime.beginTurn!;
      expect((yield* runtime.prompt({ prompt: [{ type: "text", text: "next" }] })).stopReason).toBe(
        "end_turn",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("authorizes each request from the committed catalog, reading no keys", () =>
    Effect.gen(function* () {
      const api = yield* Effect.promise(() => startModelApi(() => "length"));
      yield* Effect.addFinalizer(() => Effect.promise(api.close));
      const base = fixture(api.origin);
      const reads = { keys: 0, settings: 0, catalog: 0 };
      const settings = {
        ...base,
        // Resolves keys under the settings write lock: only to start the process.
        resolveCustomModels: () =>
          Effect.sync(() => void reads.keys++).pipe(Effect.andThen(base.resolveCustomModels())),
        // Materializes provider-environment secrets.
        getSettings: Effect.sync(() => void reads.settings++).pipe(
          Effect.andThen(base.getSettings),
        ),
        committedCustomModels: () => {
          reads.catalog++;
          return base.committedCustomModels();
        },
      };
      const droid = makeLoopingDroid(3);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        settings,
        instanceId,
        droid.factory,
      );
      const runtime = yield* factory(runtimeInput);
      yield* runtime.prompt({ prompt: [{ type: "text", text: "go" }] });
      expect(api.requests()).toBe(3);
      expect(reads).toMatchObject({ keys: 1, settings: 0 });
      expect(reads.catalog).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "never dispatches with a key whose rotation committed after authorization read it",
    () =>
      Effect.gen(function* () {
        const api = yield* Effect.promise(() => startModelApi(() => "stop"));
        yield* Effect.addFinalizer(() => Effect.promise(api.close));
        const base = fixture(api.origin);
        const original = yield* base.resolveCustomModels();
        const rotated = original.map(
          ({
            credentialError: _unavailable,
            apiKey: _old,
            ...connection
          }): ResolvedModelConnection => ({
            ...connection,
            credentialId: "rotated-key",
            apiKey: Redacted.make("limits-new-key-0123456789"),
          }),
        );
        let current = original;
        let armed = false;
        let committed = false;
        // The per-request check reads the catalog; the rotation commits at the
        // very next scheduling boundary, before any awaited check could resume.
        const read = () => {
          const snapshot = { revision: 0, connections: current };
          if (armed) {
            armed = false;
            queueMicrotask(() => {
              current = rotated;
              committed = true;
            });
          }
          return snapshot;
        };
        const settings = {
          ...base,
          resolveCustomModels: () => Effect.sync(() => current),
          committedCustomModels: read,
        };
        const dispatched: Array<{
          readonly authorization: unknown;
          readonly afterCommit: boolean;
        }> = [];
        const onStart = (message: unknown) => {
          const request = (message as { readonly request: NodeHttp.ClientRequest }).request;
          dispatched.push({
            authorization: request.getHeader("authorization"),
            afterCommit: committed,
          });
        };
        NodeDiagnosticsChannel.subscribe("http.client.request.created", onStart);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            NodeDiagnosticsChannel.unsubscribe("http.client.request.created", onStart),
          ),
        );
        const droid = makeLoopingDroid(1, () => {
          armed = true;
        });
        const factory = yield* makeDroidCustomModelsRuntimeFactory(
          settings,
          instanceId,
          droid.factory,
        );
        const runtime = yield* factory(runtimeInput);
        yield* runtime.prompt({ prompt: [{ type: "text", text: "go" }] }).pipe(Effect.exit);
        // Either the request left before the rotation committed, or it was refused.
        expect(
          dispatched.filter(
            (entry) =>
              entry.afterCommit && entry.authorization === "Bearer limits-real-key-0123456789",
          ),
        ).toEqual([]);
        expect(committed).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "authorizes requests without waiting on a settings reload or reading keys",
    () =>
      Effect.gen(function* () {
        const api = yield* Effect.promise(() => startModelApi(() => "stop"));
        yield* Effect.addFinalizer(() => Effect.promise(api.close));
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let keyReads = 0;
        let holdNextKeyRead = false;
        // The real secret store, holding the next custom-model key read.
        const secretLayer = Layer.effect(
          ServerSecretStore.ServerSecretStore,
          Effect.gen(function* () {
            const store = yield* ServerSecretStore.ServerSecretStore;
            return {
              ...store,
              get: (name: string) =>
                Effect.gen(function* () {
                  if (name.startsWith("custom-model-")) {
                    keyReads++;
                    if (holdNextKeyRead) {
                      holdNextKeyRead = false;
                      yield* Deferred.succeed(reading, undefined);
                      yield* Deferred.await(release);
                    }
                  }
                  return yield* store.get(name);
                }),
            };
          }),
        ).pipe(Layer.provide(ServerSecretStore.layer));
        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsModule.ServerSettingsService;
          const config = yield* ServerConfig.ServerConfig;
          yield* settings.start;
          const pi = ProviderInstanceId.make("pi");
          yield* settings.saveCustomModel({
            revision: 0,
            connection: {
              id: "reload",
              name: "Reload",
              protocol: "openai-completions",
              baseUrl: api.origin,
              models: [
                {
                  id: "fixture",
                  modelId: "vendor/fixture",
                  name: "Fixture",
                  configurationMode: "manual",
                  contextWindow: 32_000,
                  maxOutputTokens: 1_024,
                  images: false,
                  reasoning: false,
                  instanceIds: [pi],
                },
              ],
            },
            apiKey: Redacted.make("reload-real-key-0123456789"),
          });
          const droid = makeLoopingDroid(1);
          const factory = yield* makeDroidCustomModelsRuntimeFactory(settings, pi, droid.factory);
          const runtime = yield* factory(runtimeInput);
          // A catalog written before key hints: reloading it reads the stored key.
          holdNextKeyRead = true;
          const file = decodeJson(NodeFS.readFileSync(config.settingsPath, "utf8")) as {
            customModels: { connections: Array<Record<string, unknown>> };
          };
          for (const connection of file.customModels.connections) delete connection.apiKeySuffix;
          NodeFS.writeFileSync(config.settingsPath, encodeJson(file));
          yield* Deferred.await(reading).pipe(Effect.timeout("5 seconds"));
          const readsBefore = keyReads;
          // The reload now waits on that key read; a brokered request does not.
          const result = yield* runtime
            .prompt({ prompt: [{ type: "text", text: "go" }] })
            .pipe(Effect.timeout("3 seconds"), Effect.exit);
          const readsDuring = keyReads - readsBefore;
          yield* Deferred.succeed(release, undefined);
          expect(result._tag).toBe("Success");
          expect(api.authorizations).toEqual(["Bearer reload-real-key-0123456789"]);
          expect(readsDuring).toBe(0);
        }).pipe(
          Effect.provide(
            ServerSettingsModule.layer.pipe(
              Layer.provide(secretLayer),
              Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
              Layer.provideMerge(
                Layer.fresh(
                  ServerConfig.layerTest(process.cwd(), { prefix: "scient-droid-reload-test-" }),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
    20_000,
  );

  it.effect("refuses a request made after a key rotation committed, before any change event", () =>
    Effect.gen(function* () {
      const api = yield* Effect.promise(() => startModelApi(() => "stop"));
      yield* Effect.addFinalizer(() => Effect.promise(api.close));
      const base = fixture(api.origin);
      const original = yield* base.resolveCustomModels();
      let current = original;
      const settings = {
        ...base,
        resolveCustomModels: () => Effect.sync(() => current),
        committedCustomModels: () => ({ revision: 0, connections: current }),
      };
      // The rotation commits while Droid sends its request; no change event
      // reaches the runtime, so only the broker's own check can refuse it.
      const droid = makeLoopingDroid(1, () => {
        current = original.map(
          ({
            credentialError: _unavailable,
            apiKey: _old,
            ...connection
          }): ResolvedModelConnection => ({
            ...connection,
            credentialId: "rotated-key",
            apiKey: Redacted.make("limits-new-key-0123456789"),
          }),
        );
      });
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        settings,
        instanceId,
        droid.factory,
      );
      const runtime = yield* factory(runtimeInput);
      yield* runtime.prompt({ prompt: [{ type: "text", text: "go" }] }).pipe(Effect.exit);
      expect(api.authorizations).not.toContain("Bearer limits-real-key-0123456789");
      expect(runtime.isConfigurationRetired?.()).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("routes custom-model requests through the Droid instance's proxy", () =>
    Effect.gen(function* () {
      const proxy = yield* Effect.promise(() => startModelApi(() => "stop"));
      yield* Effect.addFinalizer(() => Effect.promise(proxy.close));
      const droid = makeLoopingDroid(1);
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        fixture("http://models.example/v1"),
        instanceId,
        droid.factory,
      );
      const runtime = yield* factory({
        ...runtimeInput,
        environment: { HTTP_PROXY: proxy.origin, NO_PROXY: "127.0.0.1,localhost,::1" },
      });
      const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "go" }] });
      expect(result.stopReason).toBe("end_turn");
      expect(proxy.requests()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "leaves long turns that keep finishing their responses alone",
    () =>
      Effect.gen(function* () {
        const api = yield* Effect.promise(() => startModelApi(() => "tool_calls"));
        yield* Effect.addFinalizer(() => Effect.promise(api.close));
        const droid = makeLoopingDroid(150);
        const factory = yield* makeDroidCustomModelsRuntimeFactory(
          fixture(api.origin),
          instanceId,
          droid.factory,
        );
        const runtime = yield* factory(runtimeInput);
        const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "work" }] });
        expect(result.stopReason).toBe("end_turn");
        expect(api.requests()).toBe(150);
        expect(droid.cancels()).toBe(0);
        expect(runtime.requestLimitBreach?.()).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    20_000,
  );
});
