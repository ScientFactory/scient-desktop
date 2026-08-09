import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { assetRouteHandler } from "../http.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { issueAssetUrl } from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-pdf-route-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  NodeHttpPlatform.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const runRequest = (relativeUrl: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      new Request(new URL(relativeUrl, "http://127.0.0.1:3774").toString(), init),
    );
    const response = yield* assetRouteHandler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    return HttpServerResponse.toWeb(response, {
      withoutBody: request.method === "HEAD",
      context: Context.empty(),
    });
  });

describe("asset route", () => {
  it.effect("serves full, HEAD, partial, and unsatisfiable PDF requests", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-pdf-route-" });
      const pdfPath = path.join(root, "paper.pdf");
      const bytes = new TextEncoder().encode("%PDF-1.7\n0123456789");
      yield* fileSystem.writeFile(pdfPath, bytes);
      const asset = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-pdf-route"),
          path: pdfPath,
        },
        workspaceRoot: root,
      });

      const full = yield* runRequest(asset.relativeUrl);
      expect(full.status).toBe(200);
      expect(full.headers.get("accept-ranges")).toBe("bytes");
      expect(full.headers.get("content-type")).toBe("application/pdf");
      expect(full.headers.get("etag")).toBeTruthy();
      expect(new Uint8Array(yield* Effect.promise(() => full.arrayBuffer()))).toEqual(bytes);

      const head = yield* runRequest(asset.relativeUrl, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(bytes.length));
      expect(yield* Effect.promise(() => head.text())).toBe("");

      const partial = yield* runRequest(asset.relativeUrl, {
        headers: { Range: "bytes=9-12" },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(`bytes 9-12/${bytes.length}`);
      expect(yield* Effect.promise(() => partial.text())).toBe("0123");

      const unsatisfiable = yield* runRequest(asset.relativeUrl, {
        headers: { Range: `bytes=${bytes.length}-` },
      });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${bytes.length}`);

      const invalid = yield* runRequest(asset.relativeUrl.replace("/api/assets/", "/api/assets/x"));
      expect(invalid.status).toBe(404);

      yield* fileSystem.writeFile(pdfPath, new TextEncoder().encode("%PDF changed"));
      const changed = yield* runRequest(asset.relativeUrl);
      expect(changed.status).toBe(409);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
