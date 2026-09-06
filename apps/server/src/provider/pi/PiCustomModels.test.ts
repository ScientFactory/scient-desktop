import { piModelSettings } from "./PiCustomModelsTestHelpers.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import type { ResolvedModelConnection } from "../../customModels.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { makePiCustomModelsClientFactory } from "./PiCustomModels.ts";
import type { PiRpcClient, PiRpcSpawnOptions } from "./PiRpcClient.ts";

const client: PiRpcClient = {
  events: Stream.empty,
  getState: () => Effect.succeed({}),
  getAvailableModels: () => Effect.succeed({ models: [] }),
  getCommands: () =>
    Effect.succeed({ commands: [{ name: "scient-models-refresh", source: "extension" }] }),
  getThinkingLevels: () => Effect.succeed({ levels: [] }),
  getSessionStats: () => Effect.die("Not used"),
  clearQueue: () => Effect.void,
  synchronizeEvents: () => Effect.void,
  setModel: () => Effect.die("Not used"),
  setThinkingLevel: () => Effect.void,
  prompt: () => Effect.void,
  abort: () => Effect.void,
  respondToExtensionUi: () => Effect.void,
  close: () => Effect.void,
};

for (const change of ["rotate", "remove", "detach", "unselected-key"] as const) {
  it.effect(`retires loaded Pi authority on ${change}, not on adding a model`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-revocation-" });
      const id = ProviderInstanceId.make("pi");
      const base: ResolvedModelConnection = {
        id: "fixture",
        name: "Fixture",
        baseUrl: "http://localhost:9000/v1",
        protocol: "openai-completions",
        credentialId: "first",
        apiKey: Redacted.make("synthetic"),
        models: [
          {
            id: "a",
            modelId: "a",
            name: "A",
            contextWindow: 32000,
            maxOutputTokens: 8192,
            images: false,
            reasoning: false,
            instanceIds: [id],
          },
        ],
      };
      let connections = [base, { ...base, id: "unselected" }];
      const snapshot = () => ({
        ...DEFAULT_SERVER_SETTINGS,
        customModels: { revision: 0, connections },
      });
      const updates = yield* PubSub.unbounded<ReturnType<typeof snapshot>>();
      const closed = yield* Deferred.make<void>();
      const http = yield* HttpClient.HttpClient;
      let closes = 0;
      let failCheck = false;
      const failedCheck = yield* Deferred.make<void>();
      const factory = yield* makePiCustomModelsClientFactory(
        {
          getSettings: Effect.gen(function* () {
            if (failCheck) {
              yield* Deferred.succeed(failedCheck, undefined);
              return yield* new ServerSettingsError({
                settingsPath: "fixture",
                operation: "read-file",
                cause: "synthetic failure",
              });
            }
            return snapshot();
          }),
          resolveCustomModels: () => Effect.sync(() => connections),
          subscribeChanges: PubSub.subscribe(updates).pipe(Effect.map(Stream.fromSubscription)),
        },
        id,
        root,
        (options) =>
          Effect.gen(function* () {
            const response = yield* http
              .get(options.env!.SCIENT_PI_MODELS_URL!, {
                headers: { authorization: "Bearer " + options.env!.SCIENT_PI_MODELS_TOKEN! },
              })
              .pipe(Effect.orDie);
            expect(response.status).toBe(200);
            return {
              ...client,
              close: () =>
                Effect.sync(() => {
                  closes++;
                }).pipe(Effect.andThen(Deferred.succeed(closed, undefined)), Effect.asVoid),
            };
          }),
      );
      const runtime = yield* factory({ command: "synthetic" });
      failCheck = true;
      yield* PubSub.publish(updates, snapshot());
      yield* Deferred.await(failedCheck);
      const blocked = yield* runtime.prompt("Must not send on failed check").pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      if (blocked._tag === "Failure")
        expect(blocked.failure).toMatchObject({ detail: "Could not check Pi model connections." });
      expect(closes).toBe(0);
      failCheck = false;
      yield* runtime.prompt("Recovered");
      connections = connections.map((connection) => ({
        ...connection,
        models: [...connection.models, { ...connection.models[0]!, id: "b", modelId: "b" }],
      }));
      yield* PubSub.publish(updates, snapshot());
      yield* runtime.prompt("Still authorized");
      expect(closes).toBe(0);
      connections =
        change === "remove"
          ? []
          : connections.map((connection) =>
              change === "detach"
                ? { ...connection, models: [] }
                : change === "unselected-key" && connection.id !== "unselected"
                  ? connection
                  : { ...connection, credentialId: "rotated" },
            );
      yield* PubSub.publish(updates, snapshot());
      yield* Deferred.await(closed);
      expect((yield* runtime.prompt("Must not send").pipe(Effect.result))._tag).toBe("Failure");
      expect(closes).toBe(1);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  );
}
it.effect("scopes and closes the credential bootstrap and denies unauthenticated access", () =>
  Effect.gen(function* () {
    let captured: PiRpcSpawnOptions | undefined;
    let endpoint = "";
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-model-bootstrap-" });
        const id = ProviderInstanceId.make("pi_work");
        const requested: string[] = [];
        const factory = yield* makePiCustomModelsClientFactory(
          piModelSettings(
            {
              resolveCustomModels: (instanceId) =>
                Effect.sync(() => {
                  requested.push(instanceId);
                  return [
                    {
                      id: "fixture",
                      name: "Test",
                      protocol: "openai-completions",
                      baseUrl: "https://example.test/v1",
                      credentialId: "opaque",
                      apiKey: Redacted.make("synthetic-key"),
                      models: [
                        {
                          id: "one",
                          modelId: "one",
                          name: "One",
                          contextWindow: 32000,
                          maxOutputTokens: 100,
                          reasoning: false,
                          images: false,
                          instanceIds: [id],
                        },
                      ],
                    },
                    {
                      id: "broken",
                      name: "Broken",
                      protocol: "openai-completions",
                      baseUrl: "https://example.test/v1",
                      credentialId: "missing",
                      models: [],
                      credentialError: "Re-enter the API key for Broken in Custom models.",
                    },
                  ];
                }),
            },
            id,
          ),
          id,
          root,
          (options) =>
            Effect.sync(() => {
              captured = options;
              return client;
            }),
        );
        const wrapped = yield* factory({ command: "pi", env: { PATH: "/test" } });
        endpoint = captured!.env!.SCIENT_PI_MODELS_URL!;
        const token = captured!.env!.SCIENT_PI_MODELS_TOKEN!;
        const initialReads = requested.length;
        for (const authorization of ["", "Bearer wrong"]) {
          const response = yield* HttpClient.get(endpoint, { headers: { authorization } });
          expect(response.status).toBe(403);
        }
        expect(requested).toHaveLength(initialReads);
        const authorized = yield* HttpClient.get(endpoint, {
          headers: { authorization: "Bearer " + token },
        });
        expect(authorized.status).toBe(200);
        const body = yield* authorized.text;
        expect(body).toContain("synthetic-key");
        expect(body).not.toContain("scient_broken");
        expect(yield* wrapped.setModel("scient_broken", "one").pipe(Effect.flip)).toMatchObject({
          _tag: "PiRpcProtocolError",
          detail: expect.stringContaining("Re-enter"),
        });
        expect(requested.length).toBeGreaterThan(initialReads);
        expect(requested.every((id) => id === "pi_work")).toBe(true);
        const source = yield* fs.readFileString(captured!.args!.at(-1)!);
        expect(source).not.toContain("synthetic-key");
        expect(source).not.toContain(token);
        expect(captured!.args!.join(" ")).not.toContain(token);
        expect(Object.values(captured!.env!)).not.toContain("synthetic-key");
      }),
    );
    const reachable = yield* HttpClient.get(endpoint).pipe(
      Effect.match({ onSuccess: () => true, onFailure: () => false }),
    );
    expect(reachable).toBe(false);
  }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
