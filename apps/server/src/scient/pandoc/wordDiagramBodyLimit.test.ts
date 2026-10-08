// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off -- Exercise a native chunked HTTP request through the real Node adapter.
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as NetAddress from "effect/net/NetAddress";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import { wordDiagramRequestBodyLayer } from "./wordDiagramBodyLimit.ts";

const conversation = "/api/scient/conversation-export/v1/export";
const file = "/api/scient/word-export/v1/file";
const other = "/api/scient/word-export/v1/tool";
class TestApi extends HttpApi.make("test").add(
  HttpApiGroup.make("word").add(
    HttpApiEndpoint.post("exportFile", file, {
      payload: Schema.Struct({ value: Schema.String }),
      success: Schema.Struct({ length: Schema.Number }),
    }),
  ),
) {}
const testApiGroupLayer = HttpApiBuilder.group(TestApi, "word", (handlers) =>
  handlers.handle("exportFile", ({ payload }) => Effect.succeed({ length: payload.value.length })),
);
const readLength = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.text;
  return HttpServerResponse.text(String(body.length));
});

describe("Word diagram HTTP body limit", () => {
  it("accepts 8 MiB of PNG base64 on both Word routes and rejects oversized bodies before the handler", async () => {
    const routes = Layer.mergeAll(
      HttpRouter.add("POST", conversation, readLength),
      HttpRouter.add("POST", file, readLength),
      HttpRouter.add("POST", other, readLength),
      wordDiagramRequestBodyLayer,
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      const valid = "A".repeat(11_184_812);
      for (const path of [conversation, file]) {
        const response = await handler(
          new Request(`http://localhost${path}`, { method: "POST", body: valid }),
        );
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.text()).toBe(String(valid.length));
        const rejected = await handler(
          new Request(`http://localhost${path}`, {
            method: "POST",
            body: "tiny",
            headers: { "content-length": String(12 * 1024 * 1024 + 1) },
          }),
        );
        expect(rejected.status).toBe(413);
      }
      const unaffected = await handler(
        new Request(`http://localhost${other}`, {
          method: "POST",
          body: "tiny",
          headers: { "content-length": String(12 * 1024 * 1024 + 1) },
        }),
      );
      expect(unaffected.status).toBe(200);
    } finally {
      await dispose();
    }
  });

  it.effect("bounds a chunked body before HttpApiBuilder JSON decoding", () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const port = (server.address as NetAddress.InetAddress).port;
      const url = `http://127.0.0.1:${port}${file}`;
      const valid = "A".repeat(11_184_812);
      const accepted = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: valid }),
        }),
      );
      expect(accepted.status).toBe(200);
      expect(yield* Effect.promise(() => accepted.json())).toEqual({ length: valid.length });
      const declared = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const request = NodeHttp.request(
              {
                host: "127.0.0.1",
                port,
                path: file,
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "content-length": String(12 * 1024 * 1024 + 1),
                },
              },
              (response) => {
                response.resume();
                response.on("end", () => resolve(response.statusCode ?? 0));
              },
            );
            request.on("error", () => resolve(0));
            request.end();
          }),
      );
      expect(declared).toBe(413);
      const result = yield* Effect.promise(
        () =>
          new Promise<number | string>((resolve) => {
            const request = NodeHttp.request(
              {
                host: "127.0.0.1",
                port,
                path: file,
                method: "POST",
                headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
              },
              (response) => {
                response.resume();
                response.on("end", () => resolve(response.statusCode ?? 0));
              },
            );
            request.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
            const chunk = "A".repeat(256 * 1024);
            for (let n = 0; n < 49; n++) request.write(chunk);
            request.end();
          }),
      );
      // Node may close a chunked sender as soon as the bounded read fails,
      // before a 413 response can traverse the same socket. Depending on
      // whether the client is reading or still writing, it reports a reset
      // or a broken pipe.
      expect([413, "ECONNRESET", "EPIPE"]).toContain(result);
    }).pipe(
      Effect.provide(
        HttpRouter.serve(
          Layer.mergeAll(
            HttpApiBuilder.layer(TestApi).pipe(Layer.provide(testApiGroupLayer)),
            wordDiagramRequestBodyLayer,
          ).pipe(
            Layer.provideMerge(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(NodeServices.layer),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
            Layer.provide(NodeServices.layer),
          ),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    ),
  );
});
