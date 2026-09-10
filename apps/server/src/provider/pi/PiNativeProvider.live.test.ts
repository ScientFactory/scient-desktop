// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makePiRpcClient } from "./PiRpcClient.ts";
import { PI_CUSTOM_MODELS_EXTENSION } from "./PiCustomModels.ts";

// Opt in with SCIENT_PI_TEST_BINARY=/path/to/pi; no installed profile or credentials are used.
// Raw builtins only: an empty offline profile does not qualify coding-agent remote catalog
// overlays/cached updates, native filter/refresh semantics, or deferred response handles.
const binary = process.env.SCIENT_PI_TEST_BINARY;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

for (const preset of [
  {
    provider: "openai",
    model: "gpt-4o-mini",
    api: "openai-responses",
    suffix: "/v1",
    route: "/v1/responses",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    api: "anthropic-messages",
    suffix: "",
    route: "/v1/messages",
  },
  {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    api: "openai-completions",
    suffix: "/v1",
    route: "/v1/chat/completions",
  },
]) {
  it.effect.skipIf(!binary)(
    `qualifies generated ${preset.provider} binding, source changes and signature-cached refresh`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const modelId = preset.model;
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-generated-native-" });
          const profile = root + "/profile";
          const requests: Array<{
            path: string | undefined;
            key: string | undefined;
            body: Record<string, unknown>;
          }> = [];
          let payload: Array<{
            id: string;
            nativeProviderId: string;
            literalKey: string;
            config: {
              name: string;
              api: string;
              baseUrl: string;
              models: Array<{
                id: string;
                name: string;
                automatic: boolean;
                contextWindow?: number;
                maxTokens?: number;
                reasoning?: boolean;
                thinkingLevelMap?: Record<string, string | null>;
              }>;
            };
          }> = [];
          const server = NodeHttp.createServer(async (request, response) => {
            if (request.url === "/models") {
              if (request.headers.authorization !== "Bearer synthetic-bootstrap") {
                response.writeHead(403).end();
                return;
              }
              response.writeHead(200, { "content-type": "application/json" }).end(json(payload));
              return;
            }
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push({
              path: request.url,
              key:
                preset.provider === "anthropic"
                  ? String(request.headers["x-api-key"] ?? "")
                  : request.headers.authorization,
              body: decodeBody(body),
            });
            response
              .writeHead(200, { "content-type": "text/event-stream" })
              .end(responseEvents(preset.api, modelId));
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                  });
                }),
            ),
            () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                  }),
              ),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Missing loopback endpoint");
          const origin = `http://127.0.0.1:${address.port}`;
          payload = keys.map((key, index) => ({
            id: "scient_conn_" + (index === 0 ? "a" : "b"),
            nativeProviderId: preset.provider,
            literalKey: key,
            config: {
              name: "Synthetic native connection",
              api: preset.api,
              baseUrl: origin + (index === 0 ? "/a" : "/b") + preset.suffix,
              models: [{ id: modelId, name: "Synthetic native model", automatic: true }],
            },
          }));
          yield* fs.makeDirectory(profile);
          const nativeAuth = json({ [preset.provider]: { type: "api_key", key: nativeKey } });
          yield* fs.writeFileString(profile + "/auth.json", nativeAuth);
          yield* fs.writeFileString(
            profile + "/settings.json",
            json({ defaultProjectTrust: "always" }),
          );
          const extension = root + "/generated.mjs";
          yield* fs.writeFileString(extension, PI_CUSTOM_MODELS_EXTENSION);
          const probe = root + "/probe.mjs";
          // Synthetic source replacement proves getter freshness, not actual remote cache persistence.
          yield* fs.writeFileString(
            probe,
            `
import assert from "node:assert/strict";
export default function(pi) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, ${json(origin)}, "Qualification forbids external requests");
    return originalFetch(input, init);
  };
  let snapshot;
  pi.registerCommand("generated-probe", { description: "Synthetic registry probe", handler: async (args, ctx) => {
    assert.equal(process.env.SCIENT_PI_MODELS_URL, undefined);
    assert.equal(process.env.SCIENT_PI_MODELS_TOKEN, undefined);
    const registry = ctx.modelRegistry;
    if (args === "snapshot") snapshot = registry.getProvider("scient_conn_b");
    if (args === "unchanged") assert.equal(registry.getProvider("scient_conn_b"), snapshot);
    if (args === "overlay") {
      const source = registry.getProvider(${json(preset.provider)});
      pi.registerProvider({ ...source, getModels: () => source.getModels().map(model =>
        model.id === ${json(modelId)} ? { ...model, contextWindow: 144000, maxTokens: 20000,
          reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null } } : model) });
    }
    if (args.startsWith("removed-")) {
      const id = "scient_conn_" + args.slice("removed-".length);
      assert.equal(registry.getProvider(id), undefined);
      assert.equal(await registry.getProviderAuth(id), undefined);
      assert.equal(registry.getAll().some(model => model.provider === id), false);
    }
    for (const id of ["scient_conn_a", "scient_conn_b"]) {
      const alias = registry.getProvider(id);
      if (!alias) continue;
      assert.deepEqual(alias.getModels(), [{
        ...registry.getProvider(${json(preset.provider)}).getModels().find(model => model.id === ${json(modelId)}),
        provider: id, name: "Synthetic native model", baseUrl: ${json(origin)} + "/" + id.at(-1) + ${json(preset.suffix)},
      }]);
    }
    assert.equal((await registry.getProviderAuth(${json(preset.provider)})).auth.apiKey, ${json(nativeKey)});
  }});
}
`,
          );
          const client = yield* makePiRpcClient({
            command: binary!,
            cwd: root,
            args: [
              "--offline",
              "--no-session",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--no-tools",
              "-e",
              probe,
              "-e",
              extension,
            ],
            env: {
              PATH: process.env.PATH,
              HOME: root,
              PI_CODING_AGENT_DIR: profile,
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
              SCIENT_PI_MODELS_URL: origin + "/models",
              SCIENT_PI_MODELS_TOKEN: "synthetic-bootstrap",
              SCIENT_NATIVE_QA_A: "must-not-interpolate-a",
              SCIENT_NATIVE_QA_B: "must-not-interpolate-b",
            },
          });
          expect(client.version).toBe("0.84.4");
          yield* client.prompt("/scient-models-refresh");
          yield* client.prompt("/generated-probe snapshot");
          yield* client.prompt("/scient-models-refresh");
          yield* client.prompt("/generated-probe unchanged");
          const native = (yield* client.getAvailableModels()).models.find(
            (model) => model.provider === preset.provider && model.id === modelId,
          );
          expect(native?.maxTokens).toBeTypeOf("number");
          const outputBudget = (body: Record<string, unknown>) =>
            body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens;
          const prompt = Effect.fn("PiGeneratedNative.prompt")(function* (
            provider: string,
            maxTokens: number,
          ) {
            const model = yield* client.setModel(provider, modelId);
            expect(model.maxTokens).toBe(maxTokens);
            yield* client.setThinkingLevel("off");
            const events = yield* client.events.pipe(
              Stream.takeUntil((event) => "type" in event && event.type === "agent_settled"),
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              Effect.forkChild,
            );
            // Exceeds the old 32k context estimate; response usage stays at five input tokens.
            const largeInput =
              preset.provider === "openai" && requests.length === 0
                ? "0123456789 ".repeat(13637)
                : undefined;
            yield* client.prompt(largeInput ?? "Synthetic production native binding test.");
            const completed = Array.from(yield* Fiber.join(events));
            expect(
              completed.findLast((event) => "type" in event && event.type === "message_end"),
            ).toMatchObject({
              message: { stopReason: "stop", provider: preset.provider },
            });
            expect((yield* client.getState()).model?.provider).toBe(provider);
            expect(outputBudget(requests.at(-1)!.body)).toBe(maxTokens);
            if (largeInput !== undefined) {
              expect(largeInput.length).toBeGreaterThan(150000);
              expect(json(requests.at(-1)!.body).includes(largeInput)).toBe(true);
              expect(outputBudget(requests.at(-1)!.body)).toBe(16384);
              expect(outputBudget(requests.at(-1)!.body)).not.toBe(16);
            }
            expect(requests.at(-1)?.body.model).toBe(modelId);
            for (const key of [...keys, nativeKey]) expect(json(completed)).not.toContain(key);
          });
          for (const id of ["scient_conn_a", "scient_conn_b", "scient_conn_a"])
            yield* prompt(id, native!.maxTokens!);
          yield* client.prompt("/generated-probe overlay");
          yield* client.prompt("/scient-models-refresh");
          yield* client.prompt("/generated-probe snapshot");
          expect(
            (yield* client.getAvailableModels()).models.find(
              (model) => model.provider === "scient_conn_b",
            ),
          ).toMatchObject({ contextWindow: 144000, maxTokens: 20000 });
          yield* prompt("scient_conn_b", 20000);
          // A pre-existing manual-limit model with no Scient capability snapshot
          // must retain the exact native ladder, including after a refresh.
          payload = payload.map((connection) =>
            connection.id !== "scient_conn_b"
              ? connection
              : {
                  ...connection,
                  config: {
                    ...connection.config,
                    models: connection.config.models.map((model) => ({
                      ...model,
                      automatic: false,
                      contextWindow: 64000,
                      maxTokens: 1024,
                      reasoning: false,
                      thinkingLevelMap: Object.fromEntries(
                        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
                          level,
                          null,
                        ]),
                      ),
                    })),
                  },
                },
          );
          yield* client.prompt("/scient-models-refresh");
          const manualModel = yield* client.setModel("scient_conn_b", modelId);
          expect(manualModel).toMatchObject({
            contextWindow: 64000,
            maxTokens: 1024,
            reasoning: true,
          });
          expect((yield* client.getThinkingLevels()).levels).toEqual(["off", "low", "high"]);
          yield* client.setThinkingLevel("high");
          expect((yield* client.getState()).thinkingLevel).toBe("high");
          payload = payload.map((connection) => ({
            ...connection,
            config: {
              ...connection.config,
              models: connection.config.models.map((model) => ({ ...model, automatic: true })),
            },
          }));
          yield* client.prompt("/scient-models-refresh");
          payload = payload.map((connection) =>
            connection.id === "scient_conn_b"
              ? { ...connection, literalKey: "!rotated$literal" }
              : connection,
          );
          yield* client.prompt("/scient-models-refresh");
          yield* prompt("scient_conn_b", 20000);
          payload = payload.filter((connection) => connection.id !== "scient_conn_a");
          yield* client.prompt("/scient-models-refresh");
          yield* client.prompt("/generated-probe removed-a");
          expect(
            yield* client.setModel("scient_conn_a", modelId).pipe(Effect.result),
          ).toMatchObject({
            _tag: "Failure",
          });
          yield* prompt("scient_conn_b", 20000);
          payload = [];
          yield* client.prompt("/scient-models-refresh");
          yield* client.prompt("/generated-probe removed-b");
          expect(
            yield* client.setModel("scient_conn_b", modelId).pipe(Effect.result),
          ).toMatchObject({
            _tag: "Failure",
          });
          expect(requests.map((request) => request.key)).toEqual(
            [keys[0], keys[1], keys[0], keys[1], "!rotated$literal", "!rotated$literal"].map(
              (key) => (preset.provider === "anthropic" ? key : "Bearer " + key),
            ),
          );
          expect(requests.map((request) => request.path)).toEqual(
            ["a", "b", "a", "b", "b", "b"].map((id) => `/${id}${preset.route}`),
          );
          yield* Effect.logInfo("Native HTTP qualification", {
            provider: preset.provider,
            model: modelId,
            contextWindow: native!.contextWindow,
            budgets: requests.map((request) => outputBudget(request.body)),
            budgetFields: Object.keys(requests[0]!.body).filter(
              (key) => key.includes("max") && key.includes("token"),
            ),
          });
          yield* client.close();
          expect(yield* fs.readFileString(profile + "/auth.json")).toBe(nativeAuth);
          expect(yield* fs.exists(profile + "/models.json")).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 45_000 },
  );
}
const modelId = "gpt-4o-mini";
const keys = ["!literal$SCIENT_NATIVE_QA_A", "$literal${SCIENT_NATIVE_QA_B}"];
const nativeKey = "synthetic-native-openai-key";

function responseEvents(api = "openai-responses", responseModel = modelId) {
  if (api === "anthropic-messages")
    return [
      {
        type: "message_start",
        message: {
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          model: responseModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Native alias response." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${json(event)}\n\n`)
      .join("");
  if (api === "openai-completions")
    return (
      [
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          model: responseModel,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Native alias response." },
              finish_reason: null,
            },
          ],
        },
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          model: responseModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        },
      ]
        .map((event) => `data: ${json(event)}\n\n`)
        .join("") + "data: [DONE]\n\n"
    );
  const item = {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Native alias response.", annotations: [] }],
  };
  return [
    {
      type: "response.created",
      response: { id: "resp_synthetic", object: "response", status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: "Native alias response.",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_synthetic",
        object: "response",
        status: "completed",
        output: [item],
        model: responseModel,
        usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
      },
    },
  ]
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${json({ ...event, sequence_number })}\n\n`,
    )
    .join("");
}

it.effect.skipIf(!binary)(
  "qualifies full native OpenAI providers in isolated connection namespaces (Pi 0.84.4)",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-native-provider-" });
        const profile = root + "/profile";
        const requests: Array<{
          path: string | undefined;
          key: string | undefined;
          body: Record<string, unknown>;
        }> = [];
        const server = NodeHttp.createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += String(chunk);
          requests.push({
            path: request.url,
            key: request.headers.authorization,
            body: decodeBody(body),
          });
          response.writeHead(200, { "content-type": "text/event-stream" }).end(responseEvents());
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  server.off("error", reject);
                  resolve();
                });
              }),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing loopback endpoint");
        const origin = `http://127.0.0.1:${address.port}`;
        yield* fs.makeDirectory(profile);
        const nativeAuth = json({ openai: { type: "api_key", key: nativeKey } });
        yield* fs.writeFileString(profile + "/auth.json", nativeAuth);
        yield* fs.writeFileString(
          profile + "/settings.json",
          json({ defaultProjectTrust: "always" }),
        );
        const reportPath = root + "/qualification.json";
        const extension = root + "/native-provider.mjs";
        // This fixture exercises Pi's object registration directly, bypassing Scient's catalog builder.
        // Exact model objects are copied intact; only identity and endpoint are connection-specific.
        yield* fs.writeFileString(
          extension,
          `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export default function(pi) {
  const origin = ${json(origin)};
  const fetchNative = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin, "Qualification forbids non-loopback requests");
    return fetchNative(input, init);
  };
  const native = builtinProviders().find(provider => provider.id === "openai");
  assert.ok(native, "Missing native OpenAI provider");
  const selected = native.getModels().filter(model => model.id === ${json(modelId)});
  assert.equal(selected.length, 1, "Exact native model must exist");
  const original = JSON.stringify(native.getModels());
  const counters = { checks: [0, 0], resolves: [0, 0], stream: 0, streamSimple: 0 };
  const aliases = ${json(keys)}.map((key, index) => {
    const id = "scient_conn_" + (index === 0 ? "a" : "b");
    const baseUrl = origin + "/" + (index === 0 ? "a" : "b") + "/v1";
    const provider = {
      ...native,
      id,
      baseUrl,
      getModels: () => native.getModels().filter(model => model.id === ${json(modelId)})
        .map(model => ({ ...model, provider: id, baseUrl })),
      auth: { apiKey: {
        name: "Synthetic connection key",
        resolve: async ({ signal }) => {
          signal.throwIfAborted();
          counters.resolves[index]++;
          return { auth: { apiKey: key, baseUrl }, source: "synthetic literal" };
        },
        check: async ({ signal }) => {
          signal.throwIfAborted();
          counters.checks[index]++;
          return { type: "api_key", source: "synthetic literal" };
        },
      } },
    };
    pi.registerProvider(provider);
    return provider;
  });
  pi.registerCommand("native-qualify", { description: "Synthetic qualification", handler: async (args, ctx) => {
    if (args === "wrap") {
      for (const provider of aliases) pi.registerProvider({
        ...provider,
        stream: (model, context, options) => {
          counters.stream++;
          return native.stream({ ...model, provider: native.id }, context, options);
        },
        streamSimple: (model, context, options) => {
          counters.streamSimple++;
          return native.streamSimple({ ...model, provider: native.id }, context, options);
        },
      });
    } else if (args === "remove-a" || args === "remove-b") {
      const id = args === "remove-a" ? "scient_conn_a" : "scient_conn_b";
      pi.unregisterProvider(id);
      assert.equal(ctx.modelRegistry.getProvider(id), undefined);
      assert.equal(await ctx.modelRegistry.getProviderAuth(id), undefined);
      assert.equal(ctx.modelRegistry.getAll().some(model => model.provider === id), false);
    } else if (args === "stream") {
      const provider = ctx.modelRegistry.getProvider("scient_conn_b");
      const auth = await ctx.modelRegistry.getProviderAuth(provider.id);
      const result = await provider.stream(provider.getModels()[0], {
        messages: [{ role: "user", content: "Synthetic direct stream", timestamp: 0 }],
      }, { ...auth.auth, fetch: globalThis.fetch }).result();
      assert.equal(result.stopReason, "stop");
      assert.equal(result.provider, "openai");
    }
    for (const alias of aliases) {
      const effective = ctx.modelRegistry.getProvider(alias.id);
      if (!effective) continue;
      const models = effective.getModels();
      assert.deepEqual(models, [{ ...selected[0], provider: alias.id, baseUrl: alias.baseUrl }]);
      const auth = await ctx.modelRegistry.getProviderAuth(alias.id);
      assert.equal(auth.auth.apiKey, ${json(keys)}[aliases.indexOf(alias)]);
      assert.equal(auth.auth.baseUrl, alias.baseUrl);
    }
    assert.equal((await ctx.modelRegistry.getProviderAuth("openai")).auth.apiKey, ${json(nativeKey)});
    assert.equal(JSON.stringify(native.getModels()), original);
    assert.deepEqual(ctx.modelRegistry.getProvider("openai").getModels(), native.getModels());
    if (args === "remove-b") {
      assert.ok(counters.checks.every(count => count > 0));
      assert.ok(counters.resolves.every(count => count > 0));
    }
    writeFileSync(${json(reportPath)}, JSON.stringify({ native: selected[0], counters,
      hooks: { filter: !!native.filterModels, refresh: !!native.refreshModels,
        fetchDeferred: !!native.fetchDeferred, cancelDeferred: !!native.cancelDeferred } }));
  }});
}
`,
        );
        const client = yield* makePiRpcClient({
          command: binary!,
          cwd: root,
          args: [
            "--offline",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-tools",
            "-e",
            extension,
          ],
          env: {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: profile,
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1",
            SCIENT_NATIVE_QA_A: "must-not-interpolate-a",
            SCIENT_NATIVE_QA_B: "must-not-interpolate-b",
          },
        });
        expect(client.version).toBe("0.84.4");
        yield* client.prompt("/native-qualify inspect");
        const baseline = (yield* client.getAvailableModels()).models;
        const native = baseline.find(
          (model) => model.provider === "openai" && model.id === modelId,
        );
        expect(native).toBeDefined();
        expect(native).toMatchObject({ contextWindow: 128000, maxTokens: 16384 });
        for (const key of [...keys, nativeKey]) expect(json(baseline)).not.toContain(key);
        for (const id of ["scient_conn_a", "scient_conn_b"]) {
          expect(baseline.filter((model) => model.provider === id)).toEqual([
            { ...native, provider: id },
          ]);
        }

        const prompt = Effect.fn("PiNativeProvider.prompt")(function* (provider: string) {
          yield* client.setModel(provider, modelId);
          const collected = yield* client.events.pipe(
            Stream.takeUntil((event) => "type" in event && event.type === "agent_settled"),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
            Effect.forkChild,
          );
          yield* client.prompt("Reply with a synthetic native provider response.");
          const events = Array.from(yield* Fiber.join(collected));
          for (const key of [...keys, nativeKey]) expect(json(events)).not.toContain(key);
          return events.findLast((event) => "type" in event && event.type === "message_end");
        });
        // Raw aliases work for this model. Compare an optional bridge to expose its identity cost.
        for (const provider of ["scient_conn_a", "scient_conn_b", "scient_conn_a"]) {
          expect(yield* prompt(provider)).toMatchObject({
            message: { role: "assistant", stopReason: "stop", provider },
          });
          expect((yield* client.getState()).model?.provider).toBe(provider);
        }
        yield* client.prompt("/native-qualify wrap");
        expect(yield* prompt("scient_conn_a")).toMatchObject({
          message: { role: "assistant", stopReason: "stop", provider: "openai" },
        });
        // The dispatch bridge deliberately does not rewrite returned message identities.
        expect((yield* client.getState()).model?.provider).toBe("scient_conn_a");
        yield* client.prompt("/native-qualify remove-a");
        expect(yield* client.setModel("scient_conn_a", modelId).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(yield* prompt("scient_conn_b")).toMatchObject({ message: { stopReason: "stop" } });
        yield* client.prompt("/native-qualify stream");
        yield* client.prompt("/native-qualify remove-b");
        expect(yield* client.setModel("scient_conn_b", modelId).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(
          (yield* client.getAvailableModels()).models.some((model) =>
            model.provider.startsWith("scient_conn_"),
          ),
        ).toBe(false);
        expect(requests.map((request) => request.key)).toEqual(
          [keys[0], keys[1], keys[0], keys[0], keys[1], keys[1]].map((key) => "Bearer " + key),
        );
        expect(requests.map((request) => request.path)).toEqual(
          ["a", "b", "a", "a", "b", "b"].map((id) => `/${id}/v1/responses`),
        );
        // streamSimple owns native default budgeting; raw stream does not supply a default.
        for (const request of requests.slice(0, -1)) {
          expect(request.body.model).toBe(modelId);
          expect(request.body.max_output_tokens).toBe(native?.maxTokens);
          expect(request.body.tools ?? []).toEqual([]);
        }
        const report = decodeBody(yield* fs.readFileString(reportPath));
        expect(report.counters).toEqual({
          stream: 1,
          streamSimple: 2,
          checks: [expect.any(Number), expect.any(Number)],
          resolves: [expect.any(Number), expect.any(Number)],
        });
        expect(report.native).toMatchObject({ contextWindow: 128000, maxTokens: 16384 });
        yield* client.close();
        expect(yield* fs.readFileString(profile + "/auth.json")).toBe(nativeAuth);
        expect(yield* fs.exists(profile + "/models.json")).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 45_000 },
);
