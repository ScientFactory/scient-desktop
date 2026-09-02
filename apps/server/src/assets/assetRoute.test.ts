import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { EnvironmentFilePath, ThreadId } from "@t3tools/contracts";
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
import { ASSET_ROUTE_PREFIX, issueAssetUrl } from "./AssetAccess.ts";

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

  it.effect("serves and invalidates revision-pinned files outside a workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-file-route-" });
      const filePath = path.join(root, "dataset.csv");
      const original = new TextEncoder().encode("x,y\n1,2\n");
      yield* fileSystem.writeFile(filePath, original);
      const asset = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(filePath),
          access: "exact",
        },
      });

      const partial = yield* runRequest(asset.relativeUrl, { headers: { Range: "bytes=4-6" } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-type")).toContain("text/csv");
      expect(yield* Effect.promise(() => partial.text())).toBe("1,2");

      yield* fileSystem.writeFileString(filePath, "changed");
      expect((yield* runRequest(asset.relativeUrl)).status).toBe(409);

      const refreshed = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(filePath),
          access: "exact",
        },
      });
      expect((yield* runRequest(refreshed.relativeUrl)).status).toBe(200);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("serves interactive HTML and its nested local resources with normal MIME types", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-html-route-" });
      const htmlPath = path.join(root, "interactive.html");
      const scriptPath = path.join(root, "assets", "app.js");
      yield* fileSystem.makeDirectory(path.dirname(scriptPath), { recursive: true });
      yield* fileSystem.writeFileString(htmlPath, '<script src="assets/app.js"></script>');
      yield* fileSystem.writeFileString(scriptPath, "document.body.textContent = 'ready';");
      const asset = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(htmlPath),
          access: "html-document",
        },
      });
      const suffix = asset.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      const html = yield* runRequest(asset.relativeUrl);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts allow-forms allow-popups allow-modals",
      );
      expect(html.headers.get("cache-control")).toBe("no-store");

      const script = yield* runRequest(`${ASSET_ROUTE_PREFIX}/${token}/assets/app.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("javascript");
      expect(script.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => script.text())).toContain("ready");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
