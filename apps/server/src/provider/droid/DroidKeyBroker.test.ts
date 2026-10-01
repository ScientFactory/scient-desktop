// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off -- The broker is exercised as Droid uses it: plain HTTP clients.
// @effect-diagnostics globalTimers:off -- Polls a Node server callback, outside any Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderInstanceId, type CustomModelProtocol } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeDroidKeyBroker, type DroidKeyBroker } from "./DroidKeyBroker.ts";

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
  aborted: boolean;
}

type UpstreamHandler = (
  request: Captured,
  response: NodeHttp.ServerResponse,
) => void | Promise<void>;

/** A fake model API on loopback that records what the broker sends it. */
async function startUpstream(handler: UpstreamHandler) {
  const requests: Array<Captured> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const captured: Captured = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
      aborted: false,
    };
    response.on("close", () => {
      if (!response.writableFinished) captured.aborted = true;
    });
    requests.push(captured);
    await handler(captured, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const json = (response: NodeHttp.ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "set-cookie": "a=b" });
  response.end(JSON.stringify(value));
};

const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

const chatChunk = (finishReason: string | null, content = "") => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
});

const connection = (
  protocol: CustomModelProtocol,
  id: string,
  baseUrl: string,
  apiKey: string | null = `${id}-real-key-0123456789`,
): ResolvedModelConnection => ({
  id,
  name: id,
  protocol,
  baseUrl,
  credentialId: apiKey ? `${id}-credential` : null,
  apiKey: apiKey ? Redacted.make(apiKey) : null,
  models: [
    {
      id: `${id}-model`,
      modelId: `vendor/${id}`,
      name: id,
      images: false,
      reasoning: false,
      instanceIds: [ProviderInstanceId.make("droid")],
    },
  ],
});

/** What Droid sends: the capability in its provider's header, the model id in the body. */
async function droidRequest(
  broker: DroidKeyBroker,
  target: ResolvedModelConnection,
  path: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly capability?: string;
    readonly method?: string;
    readonly signal?: AbortSignal;
  } = {},
) {
  const route = broker.route(target.id)!;
  const capability = options.capability ?? route.apiKey;
  const credential =
    target.protocol === "anthropic-messages"
      ? { "x-api-key": capability, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${capability}` };
  return fetch(route.baseUrl + path, {
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...credential, ...options.headers },
    ...((options.method ?? "POST") === "POST"
      ? { body: JSON.stringify(options.body ?? { model: target.models[0]!.modelId, stream: true }) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** fetch cannot set Host or Content-Length; a DNS-rebinding browser or raw client can. */
const rawRequest = (url: string, headers: Record<string, string>) =>
  new Promise<Response>((resolve, reject) => {
    const request = NodeHttp.request(url, { method: "POST", headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += String(chunk)));
      response.on("end", () => resolve(new Response(body, { status: response.statusCode ?? 0 })));
    });
    request.on("error", reject);
    // A declared oversized body is refused before it is read.
    if (headers["content-length"]) request.write("{");
    else request.end(JSON.stringify({ model: "vendor/chat" }));
  });

/** Spellings of a key an endpoint can echo: literal, escaped at any JSON depth, URL- and \u-encoded. */
const KEY_ENCODINGS: Record<string, (key: string) => string> = {
  literal: (key) => key,
  "JSON-escaped": (key) => JSON.stringify(key).slice(1, -1),
  "JSON-escaped twice": (key) => JSON.stringify(JSON.stringify(key)).slice(1, -1),
  "JSON-escaped three times": (key) =>
    JSON.stringify(JSON.stringify(JSON.stringify(key))).slice(1, -1),
  "percent-encoded": (key) => encodeURIComponent(key),
  "percent-encoded twice": (key) => encodeURIComponent(encodeURIComponent(key)),
  "\\u-escaped": (key) =>
    [...key].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
};

const KEY_ECHOES = Object.fromEntries(
  Object.entries(KEY_ENCODINGS).map(([label, encode]) => [
    label,
    (key: string) => `{"error":{"message":"Incorrect API key provided: ${encode(key)}."}}`,
  ]),
);

const withheldMessage = (status: number) =>
  `The model endpoint returned HTTP ${status}. Scient withheld its response because it contained your API key.`;

const openAiWithheld = (status: number) => ({
  error: { type: "scient_withheld", message: withheldMessage(status) },
});

const withBroker = <A>(
  input: {
    readonly connections: ReadonlyArray<ResolvedModelConnection>;
    readonly authorized?: () => boolean;
    readonly onRetire?: () => void;
    readonly withoutTools?: boolean;
    readonly limits?: Parameters<typeof makeDroidKeyBroker>[0]["limits"];
    readonly environment?: NodeJS.ProcessEnv;
    readonly upstreamTimeoutMs?: number;
    readonly connectTimeoutMs?: number;
  },
  use: (broker: DroidKeyBroker, scope: Scope.Closeable) => Promise<A>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const broker = yield* makeDroidKeyBroker({
      connections: input.connections,
      isCurrent: () => input.authorized === undefined || input.authorized(),
      retire: Effect.sync(() => input.onRetire?.()),
      ...(input.withoutTools ? { withoutTools: true } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.upstreamTimeoutMs ? { upstreamTimeoutMs: input.upstreamTimeoutMs } : {}),
      ...(input.connectTimeoutMs ? { connectTimeoutMs: input.connectTimeoutMs } : {}),
    }).pipe(Scope.provide(scope));
    return yield* Effect.promise(() => use(broker, scope)).pipe(
      Effect.ensuring(Scope.close(scope, Exit.void)),
    );
  });

describe("Droid key broker", () => {
  it.effect("puts the real key in each protocol's header and forwards the API path", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => json(response, 200, { ok: true })),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", `${upstream.origin}/api/v1/`);
      const responses = connection("openai-responses", "responses", `${upstream.origin}/v1`);
      const anthropic = connection("anthropic-messages", "anthropic", upstream.origin);
      yield* withBroker({ connections: [chat, responses, anthropic] }, async (broker) => {
        const replies = await Promise.all([
          droidRequest(broker, chat, "/chat/completions"),
          droidRequest(broker, responses, "/responses"),
          droidRequest(broker, anthropic, "/v1/messages?beta=true", {
            headers: { "anthropic-beta": "fixture" },
          }),
        ]);
        for (const reply of replies) {
          expect(reply.status).toBe(200);
          expect(await reply.json()).toEqual({ ok: true });
          // Upstream cookies are not relayed.
          expect(reply.headers.get("set-cookie")).toBeNull();
        }
        const byPath = new Map(upstream.requests.map((request) => [request.url, request]));
        expect([...byPath.keys()].toSorted()).toEqual([
          "/api/v1/chat/completions",
          "/v1/messages?beta=true",
          "/v1/responses",
        ]);
        expect(byPath.get("/api/v1/chat/completions")!.headers.authorization).toBe(
          "Bearer chat-real-key-0123456789",
        );
        expect(byPath.get("/v1/responses")!.headers.authorization).toBe(
          "Bearer responses-real-key-0123456789",
        );
        const messages = byPath.get("/v1/messages?beta=true")!;
        expect(messages.headers["x-api-key"]).toBe("anthropic-real-key-0123456789");
        expect(messages.headers.authorization).toBeUndefined();
        expect(messages.headers["anthropic-version"]).toBe("2023-06-01");
        expect(messages.headers["anthropic-beta"]).toBe("fixture");
        // The capability never leaves the broker.
        for (const request of upstream.requests) {
          expect(JSON.stringify(request.headers)).not.toContain("scient-cap-");
          expect(request.body).not.toContain("scient-cap-");
          expect(request.headers.origin).toBeUndefined();
        }
      });
    }).pipe(Effect.scoped),
  );

  it.effect("forwards keys verbatim and sends no credential for keyless endpoints", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => json(response, 200, {})),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const literal = connection(
        "openai-responses",
        "literal",
        upstream.origin,
        "token-${HOME}-$suffix-!command",
      );
      const keyless = connection("openai-completions", "keyless", upstream.origin, null);
      yield* withBroker({ connections: [literal, keyless] }, async (broker) => {
        expect((await droidRequest(broker, literal, "/responses")).status).toBe(200);
        expect((await droidRequest(broker, keyless, "/chat/completions")).status).toBe(200);
        expect(upstream.requests[0]!.headers.authorization).toBe(
          "Bearer token-${HOME}-$suffix-!command",
        );
        expect(upstream.requests[1]!.headers.authorization).toBeUndefined();
        expect(upstream.requests[1]!.headers["x-api-key"]).toBeUndefined();
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects everything but an authenticated model request, without revealing secrets",
    () =>
      Effect.gen(function* () {
        const upstream = yield* Effect.promise(() =>
          startUpstream((_request, response) => json(response, 200, {})),
        );
        yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
        const chat = connection("openai-completions", "chat", upstream.origin);
        const anthropic = connection("anthropic-messages", "anthropic", upstream.origin);
        yield* withBroker({ connections: [chat, anthropic] }, async (broker) => {
          const chatRoute = broker.route(chat.id)!;
          const anthropicRoute = broker.route(anthropic.id)!;
          const attempts: Array<[string, Promise<Response>, number]> = [
            [
              "missing capability",
              fetch(chatRoute.baseUrl + "/chat/completions", { method: "POST", body: "{}" }),
              401,
            ],
            [
              "wrong capability",
              droidRequest(broker, chat, "/chat/completions", {
                capability: `${chatRoute.apiKey}x`,
              }),
              401,
            ],
            [
              "another route's capability",
              droidRequest(broker, chat, "/chat/completions", {
                capability: anthropicRoute.apiKey,
              }),
              401,
            ],
            [
              "capability in the wrong header",
              fetch(anthropicRoute.baseUrl + "/v1/messages", {
                method: "POST",
                headers: { authorization: `Bearer ${anthropicRoute.apiKey}` },
                body: JSON.stringify({ model: "vendor/anthropic" }),
              }),
              401,
            ],
            [
              "unknown route",
              fetch(
                chatRoute.baseUrl.replace(/[a-f0-9]{24}$/, "0".repeat(24)) + "/chat/completions",
                {
                  method: "POST",
                  headers: { authorization: `Bearer ${chatRoute.apiKey}` },
                  body: "{}",
                },
              ),
              404,
            ],
            ["another API path", droidRequest(broker, chat, "/files"), 404],
            ["path traversal", droidRequest(broker, chat, "/chat/completions/../../files"), 404],
            ["non-POST", droidRequest(broker, chat, "/chat/completions", { method: "GET" }), 403],
            [
              "CORS preflight",
              droidRequest(broker, chat, "/chat/completions", { method: "OPTIONS" }),
              403,
            ],
            [
              "browser origin",
              droidRequest(broker, chat, "/chat/completions", {
                headers: { origin: "https://attacker.example" },
              }),
              403,
            ],
            [
              "rebound host name",
              rawRequest(chatRoute.baseUrl + "/chat/completions", {
                host: "attacker.example",
                authorization: `Bearer ${chatRoute.apiKey}`,
              }),
              403,
            ],
            [
              "unconfigured model",
              droidRequest(broker, chat, "/chat/completions", {
                body: { model: "vendor/expensive" },
              }),
              403,
            ],
            [
              "not JSON",
              droidRequest(broker, chat, "/chat/completions", { body: "not json" }),
              403,
            ],
            [
              "oversized body",
              rawRequest(chatRoute.baseUrl + "/chat/completions", {
                authorization: `Bearer ${chatRoute.apiKey}`,
                "content-length": String(64 * 1024 * 1024 + 1),
              }),
              413,
            ],
          ];
          for (const [label, attempt, status] of attempts) {
            const reply = await attempt;
            expect(reply.status, label).toBe(status);
            const text = await reply.text();
            expect(reply.headers.get("access-control-allow-origin"), label).toBeNull();
            for (const secret of [
              "chat-real-key-0123456789",
              "anthropic-real-key-0123456789",
              chatRoute.apiKey,
              anthropicRoute.apiKey,
            ])
              expect(text, label).not.toContain(secret);
          }
          expect(upstream.requests).toEqual([]);
        });
      }).pipe(Effect.scoped),
  );

  it.effect("streams responses as they arrive instead of buffering them", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const upstream = yield* Effect.promise(() =>
        startUpstream(async (_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify(chatChunk(null, "first"))}\n\n`);
          await released;
          response.end(sse([chatChunk("stop", "second")]));
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        const reply = await droidRequest(broker, chat, "/chat/completions");
        expect(reply.headers.get("content-type")).toBe("text/event-stream");
        const reader = reply.body!.getReader();
        // The first event arrives while upstream is still holding the rest.
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain("first");
        release();
        let rest = "";
        for (let next = await reader.read(); !next.done; next = await reader.read())
          rest += new TextDecoder().decode(next.value);
        expect(rest).toContain("second");
      });
    }).pipe(Effect.scoped),
  );

  it.effect("stops the upstream request when Droid hangs up or the runtime closes", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify(chatChunk(null, "partial"))}\n\n`);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      const aborted = (index: number) =>
        Effect.promise(async () => {
          for (let attempt = 0; attempt < 200 && !upstream.requests[index]?.aborted; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
          return upstream.requests[index]?.aborted === true;
        });
      const scope = yield* Scope.make("sequential");
      const broker = yield* makeDroidKeyBroker({
        connections: [chat],
        isCurrent: () => true,
        retire: Effect.void,
      }).pipe(Scope.provide(scope));

      yield* Effect.promise(async () => {
        const controller = new AbortController();
        const reply = await droidRequest(broker, chat, "/chat/completions", {
          signal: controller.signal,
        });
        await reply.body!.getReader().read();
        controller.abort();
      });
      expect(yield* aborted(0)).toBe(true);

      yield* Effect.promise(async () => {
        const reply = await droidRequest(broker, chat, "/chat/completions");
        await reply.body!.getReader().read();
      });
      yield* Scope.close(scope, Exit.void);
      expect(yield* aborted(1)).toBe(true);
      // The listener is gone with its runtime.
      const afterClose = yield* Effect.promise(() =>
        droidRequest(broker, chat, "/chat/completions").then(
          () => "answered",
          () => "refused",
        ),
      );
      expect(afterClose).toBe("refused");
    }).pipe(Effect.scoped),
  );

  it.effect("withholds an error response that echoes a key, however it is encoded", () =>
    Effect.gen(function* () {
      let echo: (key: string) => string = (key) => key;
      const upstream = yield* Effect.promise(() =>
        startUpstream((request, response) => {
          const key = request.headers.authorization!.slice("Bearer ".length);
          response.writeHead(401, { "content-type": "application/json", "retry-after": "1" });
          response.end(echo(key));
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      // Quotes and backslashes change under every escaping below.
      const key = 'sk-"quo\\ted"-0123456789';
      const chat = connection("openai-completions", "chat", upstream.origin, key);
      for (const [label, form] of Object.entries(KEY_ECHOES)) {
        echo = form;
        yield* withBroker({ connections: [chat] }, async (broker) => {
          const reply = await droidRequest(broker, chat, "/chat/completions");
          expect(reply.status, label).toBe(401);
          expect(reply.headers.get("content-type"), label).toBe("application/json");
          expect(reply.headers.get("retry-after"), label).toBe("1");
          expect(await reply.json(), label).toEqual(openAiWithheld(401));
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("withholds an error response in each protocol's error shape", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((request, response) => {
          const key = request.headers.authorization?.slice("Bearer ".length);
          json(response, 403, {
            error: { message: `Key ${key ?? request.headers["x-api-key"]} is not allowed.` },
          });
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      const responses = connection("openai-responses", "responses", upstream.origin);
      const anthropic = connection("anthropic-messages", "anthropic", upstream.origin);
      yield* withBroker({ connections: [chat, responses, anthropic] }, async (broker) => {
        const replies = await Promise.all([
          droidRequest(broker, chat, "/chat/completions"),
          droidRequest(broker, responses, "/responses"),
          droidRequest(broker, anthropic, "/v1/messages"),
        ]);
        for (const reply of replies) expect(reply.status).toBe(403);
        expect(await replies[0]!.json()).toEqual(openAiWithheld(403));
        expect(await replies[1]!.json()).toEqual(openAiWithheld(403));
        expect(await replies[2]!.json()).toEqual({
          type: "error",
          error: { type: "scient_withheld", message: withheldMessage(403) },
        });
      });
    }).pipe(Effect.scoped),
  );

  it.effect("withholds an error response that echoes the capability Droid sent", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((request, response) =>
          // A validation error that quotes the request it rejected.
          json(response, 400, { error: { message: "Invalid request", request: request.body } }),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        const reply = await droidRequest(broker, chat, "/chat/completions", {
          body: {
            model: chat.models[0]!.modelId,
            messages: [
              { role: "user", content: `My settings say ${broker.route(chat.id)!.apiKey}` },
            ],
          },
        });
        expect(reply.status).toBe(400);
        expect(await reply.json()).toEqual(openAiWithheld(400));
      });
    }).pipe(Effect.scoped),
  );

  it.effect("drops a forwarded response header that holds a key or capability", () =>
    Effect.gen(function* () {
      let status = 401;
      const upstream = yield* Effect.promise(() =>
        startUpstream((request, response) => {
          const key = request.headers.authorization!.slice("Bearer ".length);
          response.writeHead(status, {
            "content-type": status === 200 ? "text/event-stream" : "application/json",
            "retry-after": "1",
            // A gateway that echoes the credential it was sent, raw and encoded.
            "x-request-id": `req-${key}`,
            "openai-organization": encodeURIComponent(key),
            "x-ratelimit-remaining-requests": "59",
          });
          response.end(
            status === 200 ? sse([chatChunk("stop", "ok")]) : '{"error":{"message":"denied"}}',
          );
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const key = "sk-header/echo+0123456789";
      const chat = connection("openai-completions", "chat", upstream.origin, key);
      for (const next of [401, 200]) {
        status = next;
        yield* withBroker({ connections: [chat] }, async (broker) => {
          const capability = broker.route(chat.id)!.apiKey;
          const reply = await droidRequest(broker, chat, "/chat/completions");
          expect(reply.status, String(next)).toBe(next);
          expect(reply.headers.get("x-request-id"), String(next)).toBeNull();
          expect(reply.headers.get("openai-organization"), String(next)).toBeNull();
          expect(reply.headers.get("retry-after"), String(next)).toBe("1");
          expect(reply.headers.get("x-ratelimit-remaining-requests"), String(next)).toBe("59");
          const everyHeader = [...reply.headers.values()].join("\n");
          expect(everyHeader, String(next)).not.toContain("0123456789");
          expect(everyHeader, String(next)).not.toContain(capability);
          await reply.arrayBuffer();
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("drops a forwarded response header that echoes the capability", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((request, response) => {
          response.writeHead(400, {
            "content-type": "application/json",
            "anthropic-request-echo": request.headers["x-echo"] as string,
          });
          response.end('{"type":"error","error":{"message":"bad"}}');
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const anthropic = connection("anthropic-messages", "anthropic", upstream.origin);
      yield* withBroker({ connections: [anthropic] }, async (broker) => {
        const capability = broker.route(anthropic.id)!.apiKey;
        const reply = await droidRequest(broker, anthropic, "/v1/messages", {
          headers: { "x-echo": `sent ${capability}` },
        });
        expect(reply.status).toBe(400);
        expect(reply.headers.get("anthropic-request-echo")).toBeNull();
        await reply.arrayBuffer();
      });
    }).pipe(Effect.scoped),
  );

  it.effect("withholds a key that straddles the error-body bound", () =>
    Effect.gen(function* () {
      let encoded = "";
      const upstream = yield* Effect.promise(() =>
        startUpstream(async (_request, response) => {
          response.writeHead(401, { "content-type": "application/json" });
          // Multibyte text: the byte bound falls far beyond the character bound.
          // The key begins three bytes before the bound.
          const head = Buffer.from(`{"error":{"message":"${"é".repeat(32_756)}`);
          expect(head.byteLength).toBe(64 * 1024 - 3);
          response.write(head);
          await new Promise((resolve) => setTimeout(resolve, 50));
          response.end(`${encoded}"}}${"x".repeat(100_000)}`);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const key = 'sk-"straddle"-0123456789';
      const chat = connection("openai-completions", "chat", upstream.origin, key);
      for (const [label, encode] of Object.entries(KEY_ENCODINGS)) {
        encoded = encode(key);
        yield* withBroker({ connections: [chat] }, async (broker) => {
          const reply = await droidRequest(broker, chat, "/chat/completions");
          expect(await reply.json(), label).toEqual(openAiWithheld(401));
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("withholds an error body it cannot check", () =>
    Effect.gen(function* () {
      let compressed = true;
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => {
          if (compressed) {
            // Sent compressed although the broker asked for identity.
            response.writeHead(401, {
              "content-type": "application/json",
              "content-encoding": "gzip",
            });
            response.end(NodeZlib.gzipSync(JSON.stringify({ error: { message: "Bad key" } })));
          } else {
            // URL-encoded far deeper than any real body: decoding it would take thousands of passes.
            json(response, 401, { error: { message: `%25${"25".repeat(30_000)}41` } });
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      for (const label of ["compressed", "nested"]) {
        compressed = label === "compressed";
        yield* withBroker({ connections: [chat] }, async (broker) => {
          const reply = await droidRequest(broker, chat, "/chat/completions");
          expect(reply.status, label).toBe(401);
          expect(reply.headers.get("content-encoding"), label).toBeNull();
          expect(await reply.json(), label).toEqual({
            error: {
              type: "scient_withheld",
              message:
                "The model endpoint returned HTTP 401. Scient withheld its response because it could not be checked for your API key.",
            },
          });
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("withholds an error that happens to contain a short placeholder key", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) =>
          json(response, 404, { error: { message: "model 'llama3' not found, try pulling it" } }),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      // A documented false positive: any occurrence of a key withholds.
      const local = connection("openai-completions", "local", upstream.origin, "ll");
      yield* withBroker({ connections: [local] }, async (broker) => {
        const reply = await droidRequest(broker, local, "/chat/completions");
        expect(await reply.json()).toEqual(openAiWithheld(404));
      });
    }).pipe(Effect.scoped),
  );

  it.effect("passes an error body without a key through unchanged", () =>
    Effect.gen(function* () {
      const body = Buffer.from(
        '{"error":{"message":"Rate limit reached — retry in 1s","detail":"%2F \\u00e9 \\\\"}}',
      );
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => {
          response.writeHead(429, {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "1",
            location: "https://elsewhere.example/steal",
          });
          response.end(body);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        const reply = await droidRequest(broker, chat, "/chat/completions");
        expect(reply.status).toBe(429);
        expect(reply.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(reply.headers.get("retry-after")).toBe("1");
        expect(reply.headers.get("location")).toBeNull();
        expect(Buffer.from(await reply.arrayBuffer()).equals(body)).toBe(true);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("bounds an error body in bytes, cutting at a character boundary", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          // Two-byte characters in odd-sized writes: writes and the bound split them.
          const text = Buffer.from(`${"é".repeat(60_000)}`);
          for (let offset = 0; offset < text.length; offset += 4_099)
            response.write(text.subarray(offset, offset + 4_099));
          response.end();
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        const reply = await droidRequest(broker, chat, "/chat/completions");
        expect(reply.status).toBe(500);
        const bytes = Buffer.from(await reply.arrayBuffer());
        expect(bytes.byteLength).toBe(64 * 1024);
        expect(bytes.equals(Buffer.from("é".repeat(32 * 1024)))).toBe(true);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("relays a successful response byte for byte, even one holding the key", () =>
    Effect.gen(function* () {
      // The model repeats a key it read elsewhere; a character is split across writes.
      const body = Buffer.from(sse([chatChunk("stop", "line\n— chat-real-key-0123456789")]));
      const split = body.indexOf("—") + 1;
      const upstream = yield* Effect.promise(() =>
        startUpstream(async (_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(body.subarray(0, split));
          await new Promise((resolve) => setTimeout(resolve, 20));
          response.end(body.subarray(split));
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        const reply = await droidRequest(broker, chat, "/chat/completions");
        expect(reply.status).toBe(200);
        expect(Buffer.from(await reply.arrayBuffer()).equals(body)).toBe(true);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("starts no upstream request once Droid has hung up", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => json(response, 200, {})),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        const route = broker.route(chat.id)!;
        // Droid hangs up while the broker is still reading its request.
        await new Promise<void>((resolve) => {
          const request = NodeHttp.request(`${route.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${route.apiKey}`,
              "content-type": "application/json",
            },
          });
          request.on("error", () => resolve());
          request.write('{"model":"vendor/chat",');
          setTimeout(() => {
            request.destroy();
            resolve();
          }, 50);
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(upstream.requests).toEqual([]);
      });
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("sends upstream requests through the instance's proxy, never loopback ones", () =>
    Effect.gen(function* () {
      const proxied: Array<{ url: string; authorization: string | undefined }> = [];
      const proxy = yield* Effect.promise(() =>
        startUpstream((request, response) => {
          proxied.push({ url: request.url, authorization: request.headers.authorization });
          json(response, 200, { via: "proxy" });
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(proxy.close));
      const direct = yield* Effect.promise(() =>
        startUpstream((_request, response) => json(response, 200, { via: "direct" })),
      );
      yield* Effect.addFinalizer(() => Effect.promise(direct.close));
      const remote = connection("openai-completions", "remote", "http://models.example/v1");
      const local = connection("openai-completions", "local", direct.origin);
      const scope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const broker = yield* makeDroidKeyBroker({
        connections: [remote, local],
        isCurrent: () => true,
        retire: Effect.void,
        environment: {
          HTTP_PROXY: proxy.origin,
          HTTPS_PROXY: proxy.origin,
          NO_PROXY: "127.0.0.1,localhost,::1",
        },
      }).pipe(Scope.provide(scope));
      const remoteReply = yield* Effect.promise(async () =>
        (await droidRequest(broker, remote, "/chat/completions")).json(),
      );
      const localReply = yield* Effect.promise(async () =>
        (await droidRequest(broker, local, "/chat/completions")).json(),
      );
      expect(remoteReply).toEqual({ via: "proxy" });
      expect(localReply).toEqual({ via: "direct" });
      expect(proxied).toEqual([
        {
          url: "http://models.example/v1/chat/completions",
          authorization: "Bearer remote-real-key-0123456789",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a revoked configuration even when the request races the retirement", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => json(response, 200, {})),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      let current = true;
      let retired = 0;
      yield* withBroker(
        { connections: [chat], authorized: () => current, onRetire: () => void retired++ },
        async (broker) => {
          expect((await droidRequest(broker, chat, "/chat/completions")).status).toBe(200);
          // Rotated in settings; the owner has not closed the runtime yet.
          current = false;
          const reply = await droidRequest(broker, chat, "/chat/completions");
          expect(reply.status).toBe(403);
          expect(upstream.requests).toHaveLength(1);
          // The broker asks its owner to retire the runtime.
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(retired).toBe(1);
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("removes tool definitions from background requests", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => json(response, 200, {})),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat], withoutTools: true }, async (broker) => {
        await droidRequest(broker, chat, "/chat/completions", {
          body: {
            model: "vendor/chat",
            messages: [{ role: "user", content: "title" }],
            tools: [{ type: "function", function: { name: "Execute" } }],
            tool_choice: "auto",
            parallel_tool_calls: true,
          },
        });
        expect(JSON.parse(upstream.requests[0]!.body)).toEqual({
          model: "vendor/chat",
          messages: [{ role: "user", content: "title" }],
        });
      });
    }).pipe(Effect.scoped),
  );
});

describe("Droid per-turn request limits", () => {
  const truncatedBodies: Record<CustomModelProtocol, () => string> = {
    "openai-completions": () => sse([chatChunk(null, "partial"), chatChunk("length")]),
    "openai-responses": () =>
      sse([
        { type: "response.created", response: { status: "in_progress" } },
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ]),
    "anthropic-messages": () =>
      sse([
        { type: "message_start", message: { stop_reason: null } },
        { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      ]),
  };
  const paths: Record<CustomModelProtocol, string> = {
    "openai-completions": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/v1/messages",
  };

  for (const protocol of Object.keys(truncatedBodies) as Array<CustomModelProtocol>) {
    it.effect(
      `stops a truncation loop after five consecutive truncated responses (${protocol})`,
      () =>
        Effect.gen(function* () {
          const upstream = yield* Effect.promise(() =>
            startUpstream((_request, response) => {
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(truncatedBodies[protocol]());
            }),
          );
          yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
          const target = connection(protocol, "loop", upstream.origin);
          const scope = yield* Scope.make("sequential");
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const broker = yield* makeDroidKeyBroker({
            connections: [target],
            isCurrent: () => true,
            retire: Effect.void,
          }).pipe(Scope.provide(scope));
          yield* broker.beginTurn;
          const breached = yield* broker.turnBreached.pipe(Effect.forkChild);
          for (let index = 0; index < 5; index++) {
            const reply = yield* Effect.promise(() =>
              droidRequest(broker, target, paths[protocol]),
            );
            expect(reply.status).toBe(200);
            yield* Effect.promise(() => reply.text());
          }
          const breach = yield* Fiber.join(breached);
          expect(breach.reason).toBe("truncated-responses");
          expect(broker.currentBreach()).toEqual(breach);
          // Droid's "Continue where you left off." never reaches the provider.
          const refused = yield* Effect.promise(() =>
            droidRequest(broker, target, paths[protocol]),
          );
          expect(refused.status).toBe(400);
          expect(yield* Effect.promise(() => refused.text())).toContain("output limit");
          expect(upstream.requests).toHaveLength(5);
          // A new turn starts with a fresh budget.
          yield* broker.beginTurn;
          expect(broker.currentBreach()).toBeUndefined();
          const next = yield* Effect.promise(() => droidRequest(broker, target, paths[protocol]));
          expect(next.status).toBe(200);
        }).pipe(Effect.scoped),
    );
  }

  it.effect("lets long agentic turns and occasional truncation through", () =>
    Effect.gen(function* () {
      let index = 0;
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) => {
          index++;
          response.writeHead(200, { "content-type": "text/event-stream" });
          // Every fourth response is cut off; tool calls in between reset the streak.
          response.end(sse([chatChunk(index % 4 === 0 ? "length" : "tool_calls")]));
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker({ connections: [chat] }, async (broker) => {
        for (let request = 0; request < 200; request++) {
          const reply = await droidRequest(broker, chat, "/chat/completions");
          expect(reply.status).toBe(200);
          await reply.text();
        }
        expect(broker.currentBreach()).toBeUndefined();
      });
    }).pipe(Effect.scoped),
  );

  it.effect("ends a turn at the absolute request ceiling, including non-streaming responses", () =>
    Effect.gen(function* () {
      const upstream = yield* Effect.promise(() =>
        startUpstream((_request, response) =>
          json(response, 200, { choices: [{ finish_reason: "tool_calls" }] }),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const chat = connection("openai-completions", "chat", upstream.origin);
      yield* withBroker(
        { connections: [chat], limits: { consecutiveTruncatedResponses: 5, upstreamRequests: 3 } },
        async (broker) => {
          for (let request = 0; request < 3; request++)
            expect((await droidRequest(broker, chat, "/chat/completions")).status).toBe(200);
          const refused = await droidRequest(broker, chat, "/chat/completions");
          expect(refused.status).toBe(400);
          expect(broker.currentBreach()?.reason).toBe("upstream-requests");
          expect(upstream.requests).toHaveLength(3);
        },
      );
    }).pipe(Effect.scoped),
  );
});

describe("Droid key broker and the endpoint's transport", () => {
  const brokerError = async (reply: Response) =>
    ((await reply.json()) as { error: { type: string; message: string } }).error;

  it.effect("opens no listener when there is no connection to broker", () =>
    Effect.gen(function* () {
      const listeners = () =>
        process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;
      // Servers that earlier tests closed leave the list a moment later.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      const before = listeners();
      const { apiKey: _key, ...lost } = connection(
        "openai-completions",
        "lost",
        "http://127.0.0.1:9/v1",
      );
      const unavailable: ResolvedModelConnection = {
        ...lost,
        credentialError: "Re-enter the API key for lost in Custom models.",
      };
      for (const connections of [[], [unavailable]]) {
        yield* withBroker({ connections }, async (broker) => {
          expect(listeners()).toBe(before);
          expect(broker.route("lost")).toBeUndefined();
          expect(broker.currentBreach()).toBeUndefined();
        });
      }
      // A connection with a route still gets its listener.
      const chat = connection("openai-completions", "chat", "http://127.0.0.1:9/v1");
      yield* withBroker({ connections: [chat] }, async () => {
        expect(listeners()).toBe(before + 1);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a network failure at once, with a final status and its cause", () =>
    Effect.gen(function* () {
      // A port nothing listens on: the server that had it is closed.
      const closed = yield* Effect.promise(() => startUpstream(() => undefined));
      yield* Effect.promise(closed.close);
      const refused = connection("openai-completions", "refused", `${closed.origin}/v1`);
      const unknown = connection(
        "openai-responses",
        "unknown",
        "http://scient-no-such-host.invalid/v1",
      );
      const silent = yield* Effect.promise(() => startUpstream(() => undefined));
      yield* Effect.addFinalizer(() => Effect.promise(silent.close));
      const stalled = connection("anthropic-messages", "stalled", silent.origin);
      const expectFailure = async (
        broker: DroidKeyBroker,
        target: ResolvedModelConnection,
        path: string,
        message: string,
      ) => {
        const reply = await droidRequest(broker, target, path);
        // Droid retries 5xx for minutes without a word; a 4xx ends the turn with this message.
        expect(reply.status, message).toBe(400);
        expect(await brokerError(reply)).toEqual({ type: "scient_broker", message });
      };
      yield* withBroker({ connections: [refused, unknown] }, async (broker) => {
        await expectFailure(
          broker,
          refused,
          "/chat/completions",
          `Scient could not connect to ${new URL(closed.origin).host}: connection refused.`,
        );
        // A real name lookup: it answers in its own time, so no short limit here.
        await expectFailure(
          broker,
          unknown,
          "/responses",
          "Scient could not connect to scient-no-such-host.invalid: host not found.",
        );
      });
      yield* withBroker({ connections: [stalled], upstreamTimeoutMs: 200 }, async (broker) => {
        await expectFailure(
          broker,
          stalled,
          "/v1/messages",
          `Scient could not connect to ${new URL(silent.origin).host}: no response in time.`,
        );
      });
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("gives up on a connection that is never established, long before a caller does", () =>
    Effect.gen(function* () {
      // Accepts the TCP connection and never answers the TLS handshake.
      const sockets = new Set<NodeNet.Socket>();
      const mute = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets) socket.destroy();
              mute.close(() => resolve());
            }),
        ),
      );
      const host = `127.0.0.1:${(mute.address() as { port: number }).port}`;
      const stalled = connection("openai-completions", "stalled", `https://${host}/v1`);
      const turns = () => new Promise((resolve) => setImmediate(resolve));

      // The production bounds, on a clock the test moves.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      yield* withBroker({ connections: [stalled] }, async (broker) => {
        let settled = false;
        const pending = droidRequest(broker, stalled, "/chat/completions").finally(() => {
          settled = true;
        });
        while (sockets.size === 0) await turns();
        // Still connecting just before the bound: nothing is answered yet.
        vi.advanceTimersByTime(14_900);
        for (let turn = 0; turn < 20; turn++) await turns();
        expect(settled).toBe(false);
        // The Test action waits 45 s and background generation 180 s; both get the cause.
        vi.advanceTimersByTime(100);
        const reply = await pending;
        expect(reply.status).toBe(400);
        expect(await brokerError(reply)).toEqual({
          type: "scient_broker",
          message: `Scient could not connect to ${host}: connection timed out.`,
        });
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "bounds establishing a connection through an HTTPS proxy too",
    () =>
      Effect.gen(function* () {
        // Accepts TCP connections and never answers: as a proxy it never answers
        // CONNECT, as a tunnel's endpoint it never completes the TLS handshake.
        const sockets = new Set<NodeNet.Socket>();
        const mute = NodeNet.createServer((socket) => {
          sockets.add(socket);
          socket.on("error", () => undefined);
        });
        const tunnels: Array<string | undefined> = [];
        const proxy = NodeHttp.createServer().on("connect", (request, client) => {
          tunnels.push(request.url);
          const [hostname, port] = request.url!.split(":");
          const target = NodeNet.connect(Number(port), hostname, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            target.pipe(client).pipe(target);
          });
          for (const socket of [client, target]) socket.on("error", () => undefined);
        });
        for (const server of [mute, proxy])
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            for (const socket of sockets) socket.destroy();
            proxy.closeAllConnections();
            await Promise.all(
              [mute, proxy].map((server) => new Promise((resolve) => server.close(resolve))),
            );
          }),
        );
        const origin = (server: NodeNet.Server) =>
          `127.0.0.1:${(server.address() as { port: number }).port}`;

        const cases = [
          // The proxy takes the connection and never answers CONNECT.
          ["models.example", `http://${origin(mute)}`],
          // The tunnel opens; the endpoint behind it never completes TLS.
          [origin(mute), `http://${origin(proxy)}`],
        ] as const;
        for (const [host, HTTPS_PROXY] of cases) {
          const stalled = connection("openai-completions", "stalled", `https://${host}/v1`);
          yield* withBroker(
            { connections: [stalled], connectTimeoutMs: 200, environment: { HTTPS_PROXY } },
            async (broker) => {
              const reply = await droidRequest(broker, stalled, "/chat/completions");
              expect(reply.status, host).toBe(400);
              expect(await brokerError(reply)).toEqual({
                type: "scient_broker",
                message: `Scient could not connect to ${host}: connection timed out.`,
              });
            },
          );
        }
        expect(tunnels).toEqual([origin(mute)]);
      }).pipe(Effect.scoped, TestClock.withLive),
    15_000,
  );

  it.effect("does not bound an established connection by the time allowed to establish it", () =>
    Effect.gen(function* () {
      // A slow model: connected at once, first byte after the connection bound.
      const slow = yield* Effect.promise(() =>
        startUpstream(async (_request, response) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          json(response, 200, { via: "slow model" });
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(slow.close));
      const proxy = yield* Effect.promise(() =>
        startUpstream(async (_request, response) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          json(response, 200, { via: "slow model behind a proxy" });
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(proxy.close));
      const direct = connection("openai-completions", "direct", slow.origin);
      const proxied = connection("openai-completions", "proxied", "http://models.example/v1");
      yield* withBroker(
        {
          connections: [direct, proxied],
          connectTimeoutMs: 100,
          environment: { HTTP_PROXY: proxy.origin, NO_PROXY: "127.0.0.1" },
        },
        async (broker) => {
          // Twice each: the second request reuses the kept-alive connection.
          for (const [target, via] of [
            [direct, "slow model"],
            [direct, "slow model"],
            [proxied, "slow model behind a proxy"],
            [proxied, "slow model behind a proxy"],
          ] as const) {
            const reply = await droidRequest(broker, target, "/chat/completions");
            expect(reply.status).toBe(200);
            expect(await reply.json()).toEqual({ via });
          }
        },
      );
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("undoes compression an endpoint applies although none was asked for", () =>
    Effect.gen(function* () {
      const truncated = sse([chatChunk(null, "partial"), chatChunk("length")]);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const upstream = yield* Effect.promise(() =>
        startUpstream(async (request, response) => {
          expect(request.headers["accept-encoding"]).toBe("identity");
          if (request.url === "/json/chat/completions") {
            response.writeHead(200, {
              "content-type": "application/json",
              "content-encoding": "gzip",
            });
            return void response.end(NodeZlib.gzipSync(JSON.stringify({ answer: "plain" })));
          }
          if (request.url === "/odd/chat/completions") {
            response.writeHead(200, {
              "content-type": "application/json",
              "content-encoding": "lz4",
            });
            return void response.end('\u0004"M\u0018');
          }
          // A stream compressed as it goes: each event is flushed when written.
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "content-encoding": "gzip",
          });
          const gzip = NodeZlib.createGzip();
          gzip.pipe(response);
          const [first, ...rest] = truncated.split("\n\n");
          gzip.write(`${first}\n\n`);
          gzip.flush();
          await released;
          gzip.end(rest.join("\n\n"));
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(upstream.close));
      const plain = connection("openai-completions", "plain", `${upstream.origin}/json`);
      const stream = connection("openai-completions", "stream", `${upstream.origin}/sse`);
      const odd = connection("openai-completions", "odd", `${upstream.origin}/odd`);
      yield* withBroker(
        {
          connections: [plain, stream],
          limits: { consecutiveTruncatedResponses: 1, upstreamRequests: 10 },
        },
        async (broker) => {
          const jsonReply = await droidRequest(broker, plain, "/chat/completions");
          expect(jsonReply.status).toBe(200);
          expect(jsonReply.headers.get("content-encoding")).toBeNull();
          expect(await jsonReply.json()).toEqual({ answer: "plain" });

          const sseReply = await droidRequest(broker, stream, "/chat/completions");
          expect(sseReply.headers.get("content-encoding")).toBeNull();
          const reader = sseReply.body!.getReader();
          // The first event arrives decoded while the endpoint still holds the rest.
          expect(new TextDecoder().decode((await reader.read()).value)).toContain("partial");
          release();
          let rest = "";
          for (let next = await reader.read(); !next.done; next = await reader.read())
            rest += new TextDecoder().decode(next.value);
          expect(rest).toContain('"finish_reason":"length"');
          // The truncation rule read the decoded stream.
          expect(broker.currentBreach()?.reason).toBe("truncated-responses");
        },
      );
      // An encoding the broker cannot undo is said, not relayed as bytes.
      yield* withBroker({ connections: [odd] }, async (broker) => {
        const oddReply = await droidRequest(broker, odd, "/chat/completions");
        expect(oddReply.status).toBe(400);
        expect((await brokerError(oddReply)).message).toBe(
          "The model endpoint compressed its response in a way Scient cannot read.",
        );
      });
    }).pipe(Effect.scoped),
  );

  it.effect("trusts the certificate authorities of the Droid instance's environment", () =>
    Effect.gen(function* () {
      // A private CA and a server certificate it signed, as a company gateway has.
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-broker-ca-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const file = (name: string) => NodePath.join(directory, name);
      const openssl = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("openssl", args, { stdio: "ignore" });
      const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
      openssl(
        "req",
        "-x509",
        ...key,
        "-keyout",
        file("ca.key"),
        "-out",
        file("ca.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=Scient test CA",
      );
      openssl(
        "req",
        ...key,
        "-keyout",
        file("server.key"),
        "-out",
        file("server.csr"),
        "-subj",
        "/CN=127.0.0.1",
      );
      NodeFS.writeFileSync(file("san.cnf"), "subjectAltName=IP:127.0.0.1\n");
      openssl(
        "x509",
        "-req",
        "-in",
        file("server.csr"),
        "-CA",
        file("ca.pem"),
        "-CAkey",
        file("ca.key"),
        "-CAcreateserial",
        "-out",
        file("server.pem"),
        "-days",
        "2",
        "-extfile",
        file("san.cnf"),
      );

      const requests: Array<string | undefined> = [];
      const server = NodeHttps.createServer(
        {
          key: NodeFS.readFileSync(file("server.key")),
          cert: NodeFS.readFileSync(file("server.pem")),
        },
        async (request, response) => {
          requests.push(request.headers.authorization);
          request.resume();
          if (request.url?.includes("slow=1"))
            await new Promise((resolve) => setTimeout(resolve, 300));
          json(response, 200, { ok: true });
        },
      );
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
      const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
      const gateway = connection("openai-completions", "gateway", `https://${host}/v1`);

      // Without the CA the request is refused before the key is sent.
      yield* withBroker({ connections: [gateway], environment: {} }, async (broker) => {
        const reply = await droidRequest(broker, gateway, "/chat/completions");
        expect(reply.status).toBe(400);
        expect((await brokerError(reply)).message).toMatch(
          new RegExp(
            `^Scient could not connect to ${host}: its TLS certificate could not be verified \\([A-Z_]+\\)\\.$`,
          ),
        );
        expect(requests).toEqual([]);
      });
      // Verification is never switched off: not by the instance's environment, and not by
      // the server's own, from which Node takes the default of every TLS connection.
      const serverFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      const restoreServerFlag = Effect.sync(() => {
        if (serverFlag === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = serverFlag;
      });
      yield* Effect.addFinalizer(() => restoreServerFlag);
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      yield* withBroker(
        { connections: [gateway], environment: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
        async (broker) => {
          expect((await droidRequest(broker, gateway, "/chat/completions")).status).toBe(400);
          expect(requests).toEqual([]);
        },
      );
      yield* restoreServerFlag;
      // Each variable Droid itself reads for its own requests.
      for (const variable of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
        requests.length = 0;
        yield* withBroker(
          { connections: [gateway], environment: { [variable]: file("ca.pem") } },
          async (broker) => {
            const reply = await droidRequest(broker, gateway, "/chat/completions");
            expect(reply.status, variable).toBe(200);
            expect(await reply.json()).toEqual({ ok: true });
            expect(requests).toEqual(["Bearer gateway-real-key-0123456789"]);
          },
        );
      }
      // Through an HTTPS proxy the tunnel is established first; a slow answer on it is
      // not cut by the time allowed to establish a connection.
      const tunnels: Array<string | undefined> = [];
      const proxy = NodeHttp.createServer().on("connect", (request, client) => {
        tunnels.push(request.url);
        const [hostname, port] = request.url!.split(":");
        const target = NodeNet.connect(Number(port), hostname, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          target.pipe(client).pipe(target);
        });
        for (const socket of [client, target]) socket.on("error", () => undefined);
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              proxy.close(() => resolve());
              proxy.closeAllConnections();
            }),
        ),
      );
      requests.length = 0;
      yield* withBroker(
        {
          connections: [gateway],
          connectTimeoutMs: 100,
          environment: {
            NODE_EXTRA_CA_CERTS: file("ca.pem"),
            HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
          },
        },
        async (broker) => {
          for (let request = 0; request < 2; request++) {
            const reply = await droidRequest(broker, gateway, "/chat/completions?slow=1");
            expect(reply.status).toBe(200);
          }
          expect(tunnels[0]).toBe(host);
          expect(requests).toHaveLength(2);
        },
      );
      // A CA file that cannot be read adds no trust, as in Node and Droid, and the
      // certificate failure it leads to names the file.
      for (const variable of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
        yield* withBroker(
          { connections: [gateway], environment: { [variable]: file("missing.pem") } },
          async (broker) => {
            const reply = await droidRequest(broker, gateway, "/chat/completions");
            expect(reply.status).toBe(400);
            const { message } = await brokerError(reply);
            expect(message).toContain("its TLS certificate could not be verified");
            expect(
              message.endsWith(
                ` The CA file ${file("missing.pem")} named by ${variable} could not be read.`,
              ),
              message,
            ).toBe(true);
          },
        );
      }
    }).pipe(Effect.scoped),
  );
});
