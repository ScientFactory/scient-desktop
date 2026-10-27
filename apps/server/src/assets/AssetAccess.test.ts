// @effect-diagnostics nodeBuiltinImport:off - tests inject swaps at the native open boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeFSP from "node:fs/promises";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetPreviewTypeValidationError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  AnalysisArtifactContentHash,
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
} from "@scientfactory/analysis";
import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactProducerId,
  ArtifactRevisionId,
  ContentSha256,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import { ComputeExecutionId, ComputeProjectId, ComputeSessionId } from "@scientfactory/compute";
import { EnvironmentFilePath } from "@t3tools/contracts";
import { ExecutionRunId } from "@scientfactory/execution";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClientRequest, HttpClientResponse, HttpServerResponse } from "effect/http";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse } from "../http.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, readMcpAppHtml, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { fakeSourceControlDriverInstance } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { sourceControlMediaResponse } from "./sourceControlMediaResponse.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};

const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === screenshotItem.id
          ? screenshotItem
          : itemId === oversizedScreenshotItem.id
            ? oversizedScreenshotItem
            : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AssetAccess", () => {
  it.effect("issues exact immutable URLs for published analysis artifacts", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifactPath = path.join(
        config.analysisDir,
        "runs",
        "project-1",
        "run-1",
        "artifacts",
        "figure-001.svg",
      );
      yield* fileSystem.makeDirectory(path.dirname(artifactPath), { recursive: true });
      yield* fileSystem.writeFileString(artifactPath, "<svg/>");
      const artifactId = AnalysisArtifactId.make("figure-001");
      const representationId = AnalysisArtifactRepresentationId.make("static-svg");
      const resource = {
        _tag: "analysis-artifact" as const,
        projectId: "project-1",
        runId: ExecutionRunId.make("run-1"),
        artifactId,
        representationId,
      };
      const result = yield* issueAssetUrl({
        resource,
        analysisArtifact: {
          artifact: {
            artifactId,
            kind: "figure",
            label: "Figure 1",
            createdAt: "2026-08-12T00:00:00.000Z",
            representations: [],
          },
          representation: {
            representationId,
            fileName: AnalysisArtifactFileName.make("figure-001.svg"),
            mediaType: "image/svg+xml",
            presentation: "static",
            requiresNetworkForFullExperience: false,
            contentHash: AnalysisArtifactContentHash.make(`sha256:${"0".repeat(64)}`),
            byteLength: 6,
          },
          path: artifactPath,
          revision: { size: 6, mtimeMs: null },
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "figure-001.svg")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(artifactPath),
        revision: { size: 6, mtimeMs: null },
      });
      expect(yield* resolveAsset(token, "figure-002.svg")).toBeNull();
      expect(yield* resolveAsset(token, "../figure-001.svg")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact immutable URLs for compute session outputs", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outputPath = path.join(
        config.computeDir,
        "sessions",
        "project-1",
        "session-1",
        "outputs",
        "figure.png",
      );
      yield* fileSystem.makeDirectory(path.dirname(outputPath), { recursive: true });
      yield* fileSystem.writeFileString(outputPath, "PNG");
      const resource = {
        _tag: "compute-output" as const,
        projectId: ComputeProjectId.make("project-1"),
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-1"),
        contentHash: `sha256:${"a".repeat(64)}`,
      };
      const result = yield* issueAssetUrl({
        resource,
        computeOutput: {
          path: outputPath,
          fileName: "figure.png",
          mediaType: "image/png",
          contentHash: resource.contentHash,
          byteLength: 3,
          revision: { size: 3, mtimeMs: null },
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));

      expect(yield* resolveAsset(token, "figure.png")).toEqual({
        kind: "file",
        path: yield* fileSystem.realPath(outputPath),
        revision: { size: 3, mtimeMs: null },
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../figure.png")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses to sign a compute output it was not asked for", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outputPath = path.join(config.computeDir, "sessions", "project-1", "held.png");
      yield* fileSystem.makeDirectory(path.dirname(outputPath), { recursive: true });
      yield* fileSystem.writeFileString(outputPath, "PNG");
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-compute-outside-",
      });
      const outsidePath = path.join(outside, "elsewhere.png");
      yield* fileSystem.writeFileString(outsidePath, "PNG");
      const resource = {
        _tag: "compute-output" as const,
        projectId: ComputeProjectId.make("project-1"),
        sessionId: ComputeSessionId.make("session-1"),
        executionId: null,
        contentHash: `sha256:${"b".repeat(64)}`,
      };
      const resolved = {
        path: outputPath,
        fileName: "held.png",
        mediaType: "image/png" as const,
        contentHash: resource.contentHash,
        byteLength: 3,
        revision: { size: 3, mtimeMs: null },
      };

      // A resolution for a different image is the wrong image, however well it
      // resolved.
      const mismatched = yield* Effect.flip(
        issueAssetUrl({
          resource,
          computeOutput: { ...resolved, contentHash: `sha256:${"c".repeat(64)}` },
        }),
      );
      expect(mismatched._tag).toBe("AssetComputeOutputNotFoundError");

      // Containment is re-established here, so a caller that resolved a path
      // outside the compute directory cannot borrow this signature for it.
      const escaped = yield* Effect.flip(
        issueAssetUrl({
          resource,
          computeOutput: { ...resolved, path: outsidePath, fileName: "elsewhere.png" },
        }),
      );
      expect(escaped._tag).toBe("AssetComputeOutputNotFoundError");

      // Nothing was signed, so nothing is missing: the same resolution issued
      // honestly still works.
      const issued = yield* issueAssetUrl({ resource, computeOutput: resolved });
      expect(issued.relativeUrl).toContain(ASSET_ROUTE_PREFIX);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  describe("readMcpAppHtml", () => {
    it.effect("accepts snapshots at the stored HTML byte limit", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        yield* fileSystem.writeFile(file, new Uint8Array(limit).fill(120));

        const bytes = yield* readMcpAppHtml(file);
        expect(bytes?.byteLength).toBe(limit);
        expect(bytes?.every((byte) => byte === 120)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects snapshots one byte past the limit and much larger files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        for (const size of [limit + 1, limit * 2]) {
          yield* fileSystem.writeFile(file, new Uint8Array(size).fill(120));
          expect(yield* readMcpAppHtml(file)).toBeNull();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("preserves UTF-8 bytes across stream chunks and accepts empty snapshots", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        for (const html of ["", "<body>" + "☃".repeat(100_000) + "</body>"]) {
          const expected = new TextEncoder().encode(html);
          yield* fileSystem.writeFile(file, expected);
          const bytes = yield* readMcpAppHtml(file);
          expect(bytes?.byteLength).toBe(expected.byteLength);
          expect(bytes && new TextDecoder().decode(bytes)).toBe(html);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    // regression: #17026 apply host color scheme to saved MCP apps
    it.effect("preserves filesystem failures instead of reporting oversized HTML", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const error = yield* readMcpAppHtml(path.join(directory, "missing.html")).pipe(Effect.flip);
        expect(error._tag).toBe("PlatformError");
        expect(error.reason._tag).toBe("NotFound");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it.effect("serves an image a tool returned inline from the stored item", () =>
    Effect.gen(function* () {
      const resource = {
        _tag: "tool-output-image" as const,
        threadId: screenshotItem.threadId,
        itemId: screenshotItem.id,
        index: 0,
      };
      const result = yield* issueAssetUrl({ resource });
      expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      expect(yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1))).toEqual({
        kind: "bytes",
        mimeType: "image/png",
        bytes: Buffer.from(screenshotPng),
      });
      const missing = yield* issueAssetUrl({ resource: { ...resource, index: 1 } }).pipe(
        Effect.flip,
      );
      expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
      const oversized = yield* issueAssetUrl({
        resource: { ...resource, itemId: oversizedScreenshotItem.id },
      }).pipe(Effect.flip);
      expect(oversized._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact URLs for media and browser documents outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-outside-" });
      for (const [name, mimeType] of [
        ["screenshot.png", "image/png"],
        ["recording.mp4", "video/mp4"],
        ["recording.webm", "video/webm"],
        ["report.html", "text/html"],
        ["report.pdf", "application/pdf"],
        ["notes.odt", "application/vnd.oasis.opendocument.text"],
        ["budget.ods", "application/vnd.oasis.opendocument.spreadsheet"],
        ["slides.odp", "application/vnd.oasis.opendocument.presentation"],
        ["notes.rtf", "application/rtf"],
        ["book.epub", "application/epub+zip"],
        ["analysis.ipynb", "application/x-ipynb+json"],
        ["tone.wav", "audio/wav"],
        ["tone.webm-audio", "audio/webm"],
        ["archive.zip", "application/zip"],
        ["archive.jar", "application/java-archive"],
        ["archive.tar", "application/x-tar"],
        ["archive.gz", "application/gzip"],
        ["archive.tgz", "application/gzip"],
        ["data.sqlite", "application/vnd.sqlite3"],
        ["data.sqlite3", "application/vnd.sqlite3"],
        ["data.db", "application/vnd.sqlite3"],
      ] as const) {
        const filePath = path.join(outside, name);
        yield* fs.writeFileString(filePath, "media");
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toMatchObject({
          kind: "file",
          path: canonicalFile,
          mimeType,
        });
        yield* fs.writeFileString(path.join(outside, "sibling.png"), "private sibling");
        expect(yield* resolveAsset(token, "sibling.png")).toBeNull();
        expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("downloads any linked file with the same exact-file identity checks as media", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-outside-" });
      for (const name of [
        "data.csv",
        "report.docx",
        "sheet.xlsx",
        "slides.pptx",
        "archive.zip",
        "no-extension",
      ]) {
        for (const directory of [root, outside]) {
          const filePath = path.join(directory, name);
          yield* fs.writeFileString(filePath, "shared file bytes");
          const resource = {
            _tag: "media-file" as const,
            threadId: ThreadId.make("thread-1"),
            path: directory === root ? name : filePath,
            disposition: "attachment" as const,
          };
          const result = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const token = suffix.slice(0, separator);
          const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
          expect(asset).toMatchObject({
            kind: "file",
            download: true,
            fileName: name,
            mimeType: "application/octet-stream",
          });
          if (asset?.kind !== "file") throw new Error("Expected a downloadable file");
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
          expect(response.headers.get("content-disposition")).toContain("attachment;");
          expect(response.headers.get("content-type")).toBe("application/octet-stream");
          expect(yield* Effect.promise(() => response.text())).toBe("shared file bytes");
          expect(yield* resolveAsset(token, "sibling.docx")).toBeNull();
          expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
          expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
          yield* fs.rename(filePath, `${filePath}.original`);
          yield* fs.writeFileString(filePath, "replacement bytes");
          expect(yield* resolveAsset(token, name)).toBeNull();
        }
      }
      const directoryError = yield* issueAssetUrl({
        resource: {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: root,
          disposition: "attachment",
        },
      }).pipe(Effect.flip);
      expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves relative media paths from the thread workspace, including outside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-relative-" });
      const root = path.join(directory, "workspace");
      yield* fs.makeDirectory(root);
      for (const relativePath of ["screenshot.png", "../recording.mp4"]) {
        const filePath = path.resolve(root, relativePath);
        yield* fs.writeFileString(filePath, "media");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: relativePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
        ).toMatchObject({
          kind: "file",
          path: yield* fs.realPath(filePath),
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("previews draft audio and video from relative workspace paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-media-" });
      for (const [name, mimeType] of [
        ["video.mp4", "video/mp4"],
        ["audio.wav", "audio/wav"],
      ] as const) {
        const filePath = path.join(root, name);
        yield* fs.writeFileString(filePath, "media bytes");
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: name },
          workspaceRoot: root,
        });
        expect(result.sourcePath).toBe(name);
        expect(result.fileRevision).toEqual(expect.any(String));
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const asset = yield* resolveAsset(token, suffix.slice(separator + 1));
        expect(asset).toMatchObject({ kind: "file", path: yield* fs.realPath(filePath), mimeType });
        if (asset?.kind !== "file") throw new Error("Expected draft media file");
        for (const [range, status, body] of [
          [undefined, 200, "media bytes"],
          ["bytes=2-5", 206, "dia "],
        ] as const) {
          const resolved = yield* resolveAsset(token, suffix.slice(separator + 1));
          if (resolved?.kind !== "file") throw new Error("Expected draft media file");
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(resolved, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-type")).toBe(mimeType);
          expect(response.headers.get("content-length")).toBe(String(body.length));
          if (range) expect(response.headers.get("content-range")).toBe("bytes 2-5/11");
          expect(yield* Effect.promise(() => response.text())).toBe(body);
        }
        for (const requestedPath of [
          name === "video.mp4" ? "audio.wav" : "video.mp4",
          `../${name}`,
        ]) {
          expect(yield* resolveAsset(token, requestedPath)).toBeNull();
        }
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "rejects draft media escapes and disallowed types without enabling non-draft media",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-boundary-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        for (const name of ["video.mp4", "audio.wav", "secret.txt"]) {
          yield* fs.writeFileString(path.join(root, name), "workspace bytes");
          yield* fs.writeFileString(path.join(directory, name), "outside bytes");
        }
        for (const [requestedPath, tag] of [
          ["../video.mp4", "AssetWorkspacePathValidationError"],
          ["../audio.wav", "AssetWorkspacePathValidationError"],
          ["secret.txt", "AssetPreviewTypeValidationError"],
        ] as const) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: requestedPath },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe(tag);
        }
        for (const name of ["video.mp4", "audio.wav"]) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("AssetPreviewTypeValidationError");
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "grants draft media symlinks only their supported canonical target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-symlink-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const outside = path.join(directory, "outside.mp4");
        const sibling = path.join(directory, "sibling.mp4");
        const secret = path.join(root, "secret.txt");
        const alias = path.join(root, "escape.mp4");
        yield* fs.writeFileString(outside, "outside bytes");
        yield* fs.writeFileString(sibling, "private sibling");
        yield* fs.writeFileString(secret, "private bytes");
        yield* fs.symlink(outside, alias);
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: "escape.mp4" },
          workspaceRoot: root,
        });
        expect(result.sourcePath).toBe("escape.mp4");
        expect(result.fileRevision).toEqual(expect.any(String));
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const name = suffix.slice(separator + 1);
        expect(name).toBe("outside.mp4");
        const expected = {
          kind: "file",
          path: yield* fs.realPath(outside),
          mimeType: "video/mp4",
        };
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        for (const requestedPath of ["sibling.mp4", "escape.mp4", "../outside.mp4"]) {
          expect(yield* resolveAsset(token, requestedPath)).toBeNull();
        }
        yield* fs.remove(alias);
        yield* fs.symlink(sibling, alias);
        const asset = yield* resolveAsset(token, name);
        expect(asset).toMatchObject(expected);
        if (asset?.kind !== "file") throw new Error("Expected canonical draft media file");
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
        expect(yield* Effect.promise(() => response.text())).toBe("outside bytes");
        yield* fs.rename(sibling, outside);
        expect(yield* resolveAsset(token, name)).toBeNull();

        yield* fs.symlink(secret, path.join(root, "disguised.wav"));
        const error = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: "disguised.wav" },
          workspaceRoot: root,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetPreviewTypeValidationError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "preserves absolute draft previews through stable symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-absolute-" });
        for (const extension of ["png", "mp4", "wav"]) {
          const target = path.join(root, `target.${extension}`);
          const alias = path.join(root, `alias.${extension}`);
          yield* fs.writeFileString(target, "preview bytes");
          yield* fs.symlink(target, alias);
          const result = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: alias },
            workspaceRoot: root,
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          expect(
            yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
          ).toMatchObject({ kind: "file", path: yield* fs.realPath(target) });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a draft media path swapped after workspace containment validation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-draft-swap-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const filePath = path.join(root, "video.mp4");
        const outside = path.join(directory, "outside.mp4");
        yield* fs.writeFileString(filePath, "workspace video");
        yield* fs.writeFileString(outside, "outside video");
        const canonicalFile = yield* fs.realPath(filePath);
        let swapped = false;
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalFile && !swapped) {
              swapped = true;
              yield* fs.remove(filePath);
              yield* fs.symlink(outside, filePath);
            }
            return info;
          }),
        });
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: "video.mp4" },
          workspaceRoot: root,
        }).pipe(Effect.result, Effect.provideService(FileSystem.FileSystem, swappingFileSystem));
        expect(swapped).toBe(true);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AssetWorkspaceAssetNotFoundError" },
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves home-relative media paths independently of the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-home-" });
      const home = path.join(directory, "var", "home", "alice");
      const filePath = path.join(home, "Downloads", "repro.mp4");
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "recording bytes");
      const canonicalFile = yield* fs.realPath(filePath);
      yield* Effect.gen(function* () {
        for (const workspaceRoot of [
          path.join(home, "project"),
          path.join(directory, "srv", "project"),
          undefined,
        ]) {
          if (workspaceRoot) yield* fs.makeDirectory(workspaceRoot, { recursive: true });
          for (const requestedPath of ["~/Downloads/repro.mp4", "~\\Downloads/repro.mp4"]) {
            const result = yield* issueAssetUrl({
              resource: {
                _tag: "media-file",
                threadId: ThreadId.make("thread-1"),
                path: requestedPath,
              },
              ...(workspaceRoot ? { workspaceRoot } : {}),
            });
            const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
            const separator = suffix.indexOf("/");
            const asset = yield* resolveAsset(
              suffix.slice(0, separator),
              suffix.slice(separator + 1),
            );
            expect(asset).toMatchObject({
              kind: "file",
              path: canonicalFile,
              mimeType: "video/mp4",
            });
            if (asset?.kind !== "file") throw new Error("Expected a resolved home media file");
            const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
            expect(yield* Effect.promise(() => response.text())).toBe("recording bytes");
          }
        }
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    }).pipe(Effect.provide(layerTest)),
  );

  // Resolving `file://attacker.test/share/cat.jpg` from an agent's markdown sent the
  // Windows user's NTLM credentials to attacker.test.
  it.effect("never resolves a network media path outside the thread's project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolved: Array<string> = [];
      const recordingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        realPath: (requestedPath) => {
          resolved.push(requestedPath);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: requestedPath,
            }),
          );
        },
      });
      const share = "//nas.test/share/project";
      for (const resource of [
        {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: "//attacker.test/s/a.png",
        },
        { _tag: "draft-workspace-file", cwd: share, path: "//attacker.test/s/a.png" },
        { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: `${share}/a.png` },
      ] as const) {
        const error = yield* issueAssetUrl({ resource, workspaceRoot: share }).pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
          Effect.flip,
        );
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }
      expect(resolved).toEqual([path.resolve(`${share}/a.png`)]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects non-previewable files, disguised targets, and directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-validation-" });
        for (const name of ["report.md", "secret.txt", "secret.%70ng", "secret.png#private.txt"]) {
          const filePath = path.join(root, name);
          yield* fs.writeFileString(filePath, "not media");
          const error = yield* issueAssetUrl({
            resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
        }
        const disguisedPath = path.join(root, "disguised.png");
        yield* fs.symlink(path.join(root, "secret.txt"), disguisedPath);
        const disguisedError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: disguisedPath,
          },
        }).pipe(Effect.flip);
        expect(disguisedError).toBeInstanceOf(AssetPreviewTypeValidationError);
        const directoryPath = path.join(root, "directory.png");
        yield* fs.makeDirectory(directoryPath);
        const directoryError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: directoryPath,
          },
        }).pipe(Effect.flip);
        expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "binds media URLs to the canonical target and rejects symlink substitution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-symlink-" });
        const filePath = path.join(root, "actual.svg");
        const aliasPath = path.join(root, "alias.png");
        const replacementPath = path.join(root, "other.svg");
        yield* fs.writeFileString(filePath, "<svg/>");
        yield* fs.writeFileString(replacementPath, "<svg>private</svg>");
        yield* fs.symlink(filePath, aliasPath);
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: aliasPath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const name = suffix.slice(separator + 1);
        const expected = { kind: "file", path: canonicalFile, mimeType: "image/svg+xml" };
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(aliasPath);
        yield* fs.symlink(replacementPath, aliasPath);
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(filePath);
        yield* fs.symlink(replacementPath, filePath);
        expect(yield* resolveAsset(token, name)).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps full and partial responses bound to the file opened during resolution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-file-" });
        const filePath = path.join(root, "recording.mp4");
        const savedPath = path.join(root, "saved.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "0123456789");
        yield* fs.writeFileString(secretPath, "private information");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        for (const [range, expected, status] of [
          [undefined, "0123456789", 200],
          ["bytes=2-5", "2345", 206],
        ] as const) {
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected a resolved media file");

          yield* fs.rename(filePath, savedPath);
          yield* fs.symlink(secretPath, filePath);
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-length")).toBe(String(expected.length));
          expect(yield* Effect.promise(() => response.text())).toBe(expected);
          yield* fs.remove(filePath);
          yield* fs.rename(savedPath, filePath);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a symlink swapped in after canonical validation but before open",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-race-" });
        const filePath = path.join(root, "recording.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "video");
        yield* fs.writeFileString(secretPath, "secret");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.remove(filePath);
              yield* fs.symlink(secretPath, filePath);
            }
            return info;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects an ancestor symlink race even when canonical path rechecks would pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-parent-race-" });
        const publicDirectory = path.join(root, "public");
        const privateDirectory = path.join(root, "private");
        yield* fs.makeDirectory(publicDirectory);
        yield* fs.makeDirectory(privateDirectory);
        const filePath = path.join(publicDirectory, "recording.mp4");
        yield* fs.writeFileString(filePath, "public video");
        yield* fs.writeFileString(path.join(privateDirectory, "recording.mp4"), "private video");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const native = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const savedDirectory = path.join(root, "saved");
        const realpathSpy = vi.mocked(NodeFSP.realpath).mockImplementationOnce(async () => {
          await native.unlink(publicDirectory);
          await native.rename(savedDirectory, publicDirectory);
          const canonical = await native.realpath(canonicalPath);
          await native.rename(publicDirectory, savedDirectory);
          await native.symlink(privateDirectory, publicDirectory, "junction");
          return canonical;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => realpathSpy.mockReset().mockImplementation(native.realpath)),
        );
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          realPath: Effect.fn(function* (requestedPath) {
            const canonical = yield* fs.realPath(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.rename(publicDirectory, savedDirectory);
              yield* Effect.promise(() =>
                NodeFSP.symlink(privateDirectory, publicDirectory, "junction"),
              );
            }
            return canonical;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("versions media by file changes rather than by re-signing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-revision-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      yield* Effect.promise(() => NodeFSP.utimes(filePath, 1_000, 1_000));
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      expect(original.fileRevision).toEqual(expect.any(String));

      yield* TestClock.adjust("1 minute");
      const renewed = yield* issueAssetUrl(input);
      expect(renewed.relativeUrl).not.toBe(original.relativeUrl);
      expect(renewed.fileRevision).toBe(original.fileRevision);

      yield* fs.writeFileString(filePath, "modified");
      yield* Effect.promise(() => NodeFSP.utimes(filePath, 2_000, 2_000));
      const edited = yield* issueAssetUrl(input);
      expect(edited.fileRevision).not.toBe(original.fileRevision);

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "modified");
      yield* Effect.promise(() => NodeFSP.utimes(replacement, 2_000, 2_000));
      yield* fs.rename(replacement, filePath);
      const replaced = yield* issueAssetUrl(input);
      expect(replaced.fileRevision).not.toBe(edited.fileRevision);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps in-place edits readable but requires a new URL after atomic replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-replacement-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      const suffix = original.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const name = suffix.slice(separator + 1);
      yield* fs.writeFileString(filePath, "in-place edit");
      const edited = yield* resolveAsset(token, name);
      if (edited?.kind !== "file") throw new Error("Expected the edited media file");
      const editedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(edited));
      expect(yield* Effect.promise(() => editedResponse.text())).toBe("in-place edit");

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "replacement");
      yield* fs.rename(replacement, filePath);
      expect(yield* resolveAsset(token, name)).toBeNull();

      const renewed = yield* issueAssetUrl(input);
      const renewedSuffix = renewed.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const renewedSeparator = renewedSuffix.indexOf("/");
      const renewedAsset = yield* resolveAsset(
        renewedSuffix.slice(0, renewedSeparator),
        renewedSuffix.slice(renewedSeparator + 1),
      );
      if (renewedAsset?.kind !== "file") throw new Error("Expected the replacement media file");
      const renewedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(renewedAsset));
      expect(yield* Effect.promise(() => renewedResponse.text())).toBe("replacement");
      yield* fs.remove(filePath);
      expect(
        yield* resolveAsset(
          renewedSuffix.slice(0, renewedSeparator),
          renewedSuffix.slice(renewedSeparator + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      for (const extension of ["otf", "ttf", "woff", "woff2"]) {
        const fontName = `preview.${extension}`;
        const fontPath = path.join(root, fontName);
        yield* fileSystem.writeFileString(fontPath, "font bytes");
        const canonicalFontPath = yield* fileSystem.realPath(fontPath);
        for (const resource of [
          { _tag: "workspace-file" as const, threadId: ThreadId.make("thread-1"), path: htmlPath },
          { _tag: "draft-workspace-file" as const, cwd: root, path: "report.html" },
        ]) {
          const url = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = url.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          expect(yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), fontName)).toEqual({
            kind: "file",
            path: canonicalFontPath,
          });
        }
      }
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
      for (const extension of [
        "odt",
        "ods",
        "odp",
        "rtf",
        "epub",
        "ipynb",
        "zip",
        "jar",
        "tar",
        "gz",
        "tgz",
        "sqlite",
        "sqlite3",
        "db",
        "docx",
        "xlsx",
        "pptx",
        "bmp",
        "heic",
        "tif",
        "tiff",
        "weba",
        "mmd",
        "mermaid",
      ]) {
        const siblingName = `private.${extension}`;
        yield* fileSystem.writeFileString(path.join(root, siblingName), "private sibling");
        for (const resource of [
          { _tag: "workspace-file" as const, threadId: ThreadId.make("thread-1"), path: htmlPath },
          { _tag: "draft-workspace-file" as const, cwd: root, path: "report.html" },
        ]) {
          const url = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = url.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          expect(yield* resolveAsset(suffix.slice(0, suffix.indexOf("/")), siblingName)).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues a rooted Unicode PDF URL without any thread context", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-rooted-asset-",
      });
      const relativePath = "ילדים/מבואות ילדים/סיכום גיל בעריכת שחר.pdf";
      const pdfPath = path.join(root, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(pdfPath), { recursive: true });
      yield* fileSystem.writeFile(pdfPath, new TextEncoder().encode("%PDF-1.7\n"));

      const result = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", cwd: root, relativePath },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(relativePath);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toMatchObject({
        kind: "file",
        path: yield* fileSystem.realPath(pdfPath),
        revision: { size: 9 },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves a rooted nested image while its draft thread has no server context", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-draft-image-" });
      const relativePath = "docs/images/diagram.svg";
      const imagePath = path.join(root, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(imagePath), { recursive: true });
      yield* fileSystem.writeFileString(imagePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          cwd: root,
          relativePath,
          threadId: ThreadId.make("unsent-draft"),
          path: imagePath,
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(relativePath);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toMatchObject({ kind: "file", path: yield* fileSystem.realPath(imagePath) });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects malformed rooted workspace locators and serves escaping symlinks alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-rooted-root-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-rooted-outside-",
      });
      const outsidePdf = path.join(outside, "outside.pdf");
      yield* fileSystem.writeFile(outsidePdf, new TextEncoder().encode("%PDF-1.7\n"));
      yield* fileSystem.symlink(outsidePdf, path.join(root, "linked.pdf"));

      const absolutePathError = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", cwd: root, relativePath: outsidePdf },
      }).pipe(Effect.flip);
      const traversalError = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", cwd: root, relativePath: "../outside.pdf" },
      }).pipe(Effect.flip);
      // A symlink leading out of the workspace is viewable, but only as its
      // own exact target: the same capability an absolute media path grants.
      const linked = yield* issueAssetUrl({
        resource: { _tag: "workspace-file", cwd: root, relativePath: "linked.pdf" },
      });

      expect(absolutePathError._tag).toBe("AssetWorkspacePathValidationError");
      expect(traversalError._tag).toBe("AssetWorkspacePathValidationError");
      expect(linked.sourcePath).toBe("linked.pdf");
      expect(linked.relativeUrl.endsWith("/outside.pdf")).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "serves a workspace symlink that leads outside as its target alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-asset-root-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-asset-outside-" });
        const figurePath = path.join(outside, "figure.svg");
        yield* fs.writeFileString(figurePath, "<svg/>");
        yield* fs.writeFileString(path.join(outside, "secret.txt"), "private");
        yield* fs.symlink(figurePath, path.join(root, "figure.svg"));

        const result = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            cwd: root,
            relativePath: "figure.svg",
            path: path.join(root, "figure.svg"),
          },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        // Exactly the linked file, never its neighbours outside the workspace.
        expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toMatchObject({
          kind: "file",
          path: yield* fs.realPath(figurePath),
        });
        expect(yield* resolveAsset(token, "secret.txt")).toBeNull();

        // A missing target is still reported as missing.
        yield* fs.remove(figurePath);
        const missing = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            cwd: root,
            relativePath: "figure.svg",
            path: path.join(root, "figure.svg"),
          },
        }).pipe(Effect.flip);
        expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact workspace URLs for every non-HTML preview", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(assetsDirectory, "private.docx"),
        "private document",
      );
      for (const extension of [
        "pdf",
        "odt",
        "ods",
        "odp",
        "rtf",
        "epub",
        "ipynb",
        "png",
        "bmp",
        "heic",
        "tif",
        "tiff",
        "docx",
        "xlsx",
        "pptx",
        "ttf",
        "otf",
        "woff",
        "woff2",
        "zip",
        "jar",
        "tar",
        "gz",
        "tgz",
        "sqlite",
        "sqlite3",
        "db",
      ]) {
        const name = `preview.${extension}`;
        const filePath = path.join(assetsDirectory, name);
        const siblingName = `other.${extension}`;
        yield* fileSystem.writeFileString(filePath, "preview");
        yield* fileSystem.writeFileString(
          path.join(assetsDirectory, siblingName),
          "private sibling",
        );
        const canonicalPath = yield* fileSystem.realPath(filePath);
        for (const resource of [
          {
            _tag: "workspace-file" as const,
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          { _tag: "draft-workspace-file" as const, cwd: root, path: `assets/${name}` },
        ]) {
          const result = yield* issueAssetUrl({ resource, workspaceRoot: root });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const token = suffix.slice(0, suffix.indexOf("/"));
          expect(yield* resolveAsset(token, name)).toEqual({
            kind: "file",
            path: canonicalPath,
            ...(extension === "pdf" ? { revision: { size: 7, mtimeMs: expect.any(Number) } } : {}),
          });
          expect(yield* resolveAsset(token, siblingName)).toBeNull();
          expect(yield* resolveAsset(token, "private.docx")).toBeNull();
          expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("previews workspace files with literal fragment characters in their paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-preview-literal-" });
      const directory = path.join(root, "assets#archive");
      yield* fileSystem.makeDirectory(directory);

      for (const name of [
        "icon#v2.png",
        "report#draft.pdf",
        "report.docx",
        "workbook.xlsx",
        "slides.pptx",
        "notes.odt",
        "budget.ods",
        "slides.odp",
        "notes.rtf",
        "book.epub",
        "analysis.ipynb",
        "specimen.ttf",
        "specimen.otf",
        "specimen.woff",
        "specimen.woff2",
        "image.bmp",
        "image.heic",
        "image.tif",
        "image.tiff",
      ]) {
        const filePath = path.join(directory, name);
        yield* fileSystem.writeFileString(filePath, "preview fixture");
        const canonicalFile = yield* fileSystem.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const token = suffix.slice(0, suffix.indexOf("/"));

        const info = yield* fileSystem.stat(canonicalFile);
        expect(yield* resolveAsset(token, name)).toEqual({
          kind: "file",
          path: canonicalFile,
          ...(name.endsWith(".pdf")
            ? {
                revision: {
                  size: Number(info.size),
                  mtimeMs: Option.match(info.mtime, {
                    onNone: () => null,
                    onSome: (mtime) => mtime.getTime(),
                  }),
                },
              }
            : {}),
        });
        if (name.endsWith(".png")) {
          expect(yield* resolveAsset(token, "other.png")).toBeNull();
        }
      }

      const disguisedPath = path.join(root, "image.png#notes.txt");
      yield* fileSystem.writeFileString(disguisedPath, "not an image");
      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: disguisedPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact workspace URLs for PDF previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-pdf-workspace-",
      });
      const sourcesDirectory = path.join(root, "sources");
      const pdfPath = path.join(sourcesDirectory, "paper.pdf");
      const siblingPath = path.join(sourcesDirectory, "private-notes.pdf");
      yield* fileSystem.makeDirectory(sourcesDirectory, { recursive: true });
      yield* fileSystem.writeFile(pdfPath, new TextEncoder().encode("%PDF-1.7\n"));
      yield* fileSystem.writeFile(siblingPath, new TextEncoder().encode("%PDF-1.7\n"));
      const canonicalPdfPath = yield* fileSystem.realPath(pdfPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: pdfPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "paper.pdf")).toMatchObject({
        kind: "file",
        path: canonicalPdfPath,
        revision: { size: 9 },
      });
      expect(yield* resolveAsset(token, "private-notes.pdf")).toBeNull();

      yield* fileSystem.writeFile(pdfPath, new TextEncoder().encode("%PDF-1.7\nchanged"));
      const staleAsset = yield* resolveAsset(token, "paper.pdf");
      expect(staleAsset).toMatchObject({ revision: { size: 9 } });

      const refreshed = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: pdfPath,
        },
        workspaceRoot: root,
      });
      const refreshedSuffix = refreshed.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const refreshedSeparator = refreshedSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          refreshedSuffix.slice(0, refreshedSeparator),
          refreshedSuffix.slice(refreshedSeparator + 1),
        ),
      ).toMatchObject({ revision: { size: 16 } });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact renewable URLs for immutable generated PDF revisions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const artifactId = ArtifactId.make("artifact-generated-pdf");
      const revisionId = ArtifactRevisionId.make("revision-generated-pdf");
      const generatedPath = path.join(
        config.documentArtifactsDir,
        "revisions",
        artifactId,
        `${revisionId}.pdf`,
      );
      const bytes = new TextEncoder().encode("%PDF-1.7\ngenerated");
      yield* fileSystem.makeDirectory(path.dirname(generatedPath), { recursive: true });
      yield* fileSystem.writeFile(generatedPath, bytes);
      const info = yield* fileSystem.stat(generatedPath);
      const generatedDocument = {
        artifact: {
          schemaVersion: 1 as const,
          authority: ArtifactAuthority.make("environment-generated-pdf"),
          logicalDocumentKey: LogicalDocumentKey.make("browser-export:generated-pdf"),
          artifactId,
          revisionId,
          contentHash: ContentSha256.make("0".repeat(64)),
          mediaType: "application/pdf" as const,
          byteLength: bytes.byteLength,
          createdAtEpochMs: 1,
          provenance: {
            kind: "browser-export" as const,
            producerId: ArtifactProducerId.make("browser"),
            operationId: ProducingOperationId.make("export-1"),
          },
        },
        path: generatedPath,
        fileName: "Generated report.pdf",
        title: "Generated report",
        revision: {
          size: Number(info.size),
          mtimeMs: Option.match(info.mtime, {
            onNone: () => null,
            onSome: (mtime) => mtime.getTime(),
          }),
        },
      };

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "generated-document",
          authority: generatedDocument.artifact.authority,
          artifactId,
          revisionId,
        },
        generatedDocument,
        generatedDocumentExpiresAtEpochMs: 10_000,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);
      const canonicalGeneratedPath = yield* fileSystem.realPath(generatedPath);

      expect(result.expiresAt).toBe(10_000);
      expect(yield* resolveAsset(token, suffix.slice(separatorIndex + 1))).toEqual({
        kind: "file",
        path: canonicalGeneratedPath,
        revision: generatedDocument.revision,
      });
      expect(yield* resolveAsset(token, "another.pdf")).toBeNull();

      const mismatched = yield* issueAssetUrl({
        resource: {
          _tag: "generated-document",
          authority: generatedDocument.artifact.authority,
          artifactId,
          revisionId: ArtifactRevisionId.make("another-revision"),
        },
        generatedDocument,
      }).pipe(Effect.flip);
      expect(mismatched._tag).toBe("AssetGeneratedDocumentNotFoundError");

      const outsidePath = path.join(path.dirname(config.documentArtifactsDir), "outside.pdf");
      yield* fileSystem.writeFile(outsidePath, bytes);
      const outside = yield* issueAssetUrl({
        resource: {
          _tag: "generated-document",
          authority: generatedDocument.artifact.authority,
          artifactId,
          revisionId,
        },
        generatedDocument: { ...generatedDocument, path: outsidePath },
      }).pipe(Effect.flip);
      expect(outside._tag).toBe("AssetGeneratedDocumentNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signs MCP render intent only for inline HTML attachments", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const extension of ["html", "pdf"]) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000031-${extension}`;
        yield* fs.writeFileString(
          path.join(config.attachmentsDir, `${attachmentId}.${extension}`),
          "capture",
        );
        for (const disposition of ["inline", "attachment"] as const) {
          const result = yield* issueAssetUrl({
            resource: {
              _tag: "attachment",
              attachmentId,
              disposition,
              renderIntent: "mcp-app",
            },
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected attachment file");
          expect("renderIntent" in asset ? asset.renderIntent : undefined).toBe(
            extension === "html" && disposition === "inline" ? "mcp-app" : undefined,
          );
          const token = suffix.slice(0, separator);
          const [payload, signature] = token.split(".");
          const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
          claims.renderIntent = claims.renderIntent ? undefined : "mcp-app";
          const tampered = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
          expect(yield* resolveAsset(tampered, suffix.slice(separator + 1))).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves document attachments inline when a viewer requests it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const [extension, mimeType] of [
        ["pdf", "application/pdf"],
        ["svg", "image/svg+xml"],
        ["bmp", "image/bmp"],
        ["ttf", "font/ttf"],
        ["otf", "font/otf"],
        ["woff", "font/woff"],
        ["woff2", "font/woff2"],
        ["weba", "audio/webm"],
        ["zip", "application/zip"],
        ["jar", "application/java-archive"],
        ["tar", "application/x-tar"],
        ["gz", "application/gzip"],
        ["tgz", "application/gzip"],
        ["sqlite", "application/vnd.sqlite3"],
        ["sqlite3", "application/vnd.sqlite3"],
        ["db", "application/vnd.sqlite3"],
      ] as const) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000001-${extension}`;
        const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.${extension}`);
        yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

        const result = yield* issueAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId,
            fileName: `report.${extension}`,
            mimeType: "text/html",
            disposition: "inline",
          },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");

        expect(
          yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
        ).toEqual({
          kind: "file",
          path: attachmentPath,
          fileName: `report.${extension}`,
          mimeType,
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps inline requests for other attachment types as downloads", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000002-7z";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.7z`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          fileName: "archive.7z",
          mimeType: "text/html",
          disposition: "inline",
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toMatchObject({ kind: "file", path: attachmentPath, download: true });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.sourcePath).toBe("favicon.svg");
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      expect(fallbackResult.sourcePath).toBeUndefined();
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues an exact capability for a saved favicon outside the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-workspace-",
      });
      const pictures = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-pictures-",
      });
      const externalPath = path.join(pictures, "custom.png");
      const siblingPath = path.join(pictures, "sibling.png");
      yield* fileSystem.writeFile(externalPath, new Uint8Array([1, 2, 3]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([4, 5, 6]));
      const canonicalPath = yield* fileSystem.realPath(externalPath);
      const canonicalSiblingPath = yield* fileSystem.realPath(siblingPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: externalPath,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(externalPath);
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-custom\.png$/);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({ kind: "file", path: canonicalPath });
      const tamperedSuffixResult = yield* resolveAsset(
        suffix.slice(0, separatorIndex),
        "sibling.png",
      );
      expect(tamperedSuffixResult).toEqual({ kind: "file", path: canonicalPath });
      expect(tamperedSuffixResult).not.toEqual({ kind: "file", path: canonicalSiblingPath });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ignores a client favicon path hint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-hint-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "hint.svg"), "<svg>hint</svg>");
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root, path: "brand/hint.svg" },
        projectFaviconPath: "brand/saved.svg",
      });

      expect(result.sourcePath).toBe(path.join("brand", "saved.svg"));
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-saved\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues revision-pinned exact capabilities for arbitrary environment files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-exact-file-" });
      const filePath = path.join(root, "outside workspace", "figure.png");
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFile(filePath, new Uint8Array([137, 80, 78, 71]));

      const issued = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(filePath),
          access: "exact",
        },
      });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const resolved = yield* resolveAsset(
        suffix.slice(0, separatorIndex),
        suffix.slice(separatorIndex + 1),
      );

      expect(issued.sourcePath).toBe(yield* fileSystem.realPath(filePath));
      expect(resolved).toMatchObject({
        kind: "file",
        path: yield* fileSystem.realPath(filePath),
        revision: { size: 4 },
      });
      expect(yield* resolveAsset(suffix.slice(0, separatorIndex), "sibling.png")).toBeNull();

      const replacementPath = path.join(root, "replacement.png");
      yield* fileSystem.writeFile(replacementPath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.remove(filePath);
      yield* fileSystem.symlink(replacementPath, filePath);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("serves an HTML entry and non-hidden local assets without escaping its directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-html-file-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-html-outside-",
      });
      const htmlPath = path.join(root, "interactive.html");
      const scriptPath = path.join(root, "assets", "interactive.js");
      const dataPath = path.join(root, "data", "measurements.json");
      yield* fileSystem.makeDirectory(path.dirname(scriptPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(dataPath), { recursive: true });
      yield* fileSystem.writeFileString(htmlPath, '<script src="assets/interactive.js"></script>');
      yield* fileSystem.writeFileString(scriptPath, "document.body.dataset.ready = 'true';");
      yield* fileSystem.writeFileString(dataPath, '{"value":42}');
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const outsidePath = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsidePath, "secret");
      yield* fileSystem.symlink(outsidePath, path.join(root, "linked-secret.txt"));

      const issued = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(htmlPath),
          access: "html-document",
        },
      });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "interactive.html")).toMatchObject({
        path: yield* fileSystem.realPath(htmlPath),
        cacheControl: "no-store",
      });
      expect(yield* resolveAsset(token, "assets/interactive.js")).toMatchObject({
        path: yield* fileSystem.realPath(scriptPath),
      });
      expect(yield* resolveAsset(token, "data/measurements.json")).toMatchObject({
        path: yield* fileSystem.realPath(dataPath),
      });
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, "linked-secret.txt")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "interactive.html")).toBeNull();

      yield* TestClock.adjust("2 hours");
      expect(yield* resolveAsset(token, "interactive.html")).not.toBeNull();
      yield* TestClock.adjust("23 hours");
      expect(yield* resolveAsset(token, "interactive.html")).toBeNull();
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("honors a shorter internal lifetime for controlled HTML rendering", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-controlled-html-file-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<main>Report</main>");

      const issued = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(htmlPath),
          access: "html-document",
        },
        expiresInMs: 2 * 60_000,
      });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).not.toBeNull();
      yield* TestClock.adjust("119 seconds");
      expect(yield* resolveAsset(token, "report.html")).not.toBeNull();
      yield* TestClock.adjust("2 seconds");
      expect(yield* resolveAsset(token, "report.html")).toBeNull();
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("rejects relative paths and non-HTML document grants", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-invalid-file-" });
      const textPath = path.join(root, "notes.txt");
      yield* fileSystem.writeFileString(textPath, "notes");

      const relative = yield* Effect.flip(
        issueAssetUrl({
          resource: {
            _tag: "environment-file",
            path: EnvironmentFilePath.make("notes.txt"),
            access: "exact",
          },
        }),
      );
      expect(relative._tag).toBe("AssetEnvironmentFilePathValidationError");

      const wrongDocumentType = yield* Effect.flip(
        issueAssetUrl({
          resource: {
            _tag: "environment-file",
            path: EnvironmentFilePath.make(textPath),
            access: "html-document",
          },
        }),
      );
      expect(wrongDocumentType._tag).toBe("AssetEnvironmentFilePathValidationError");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("serves a host's credentialed media through that host's driver", () => {
    const fetched: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    const url = "https://github.com/owner/repo/blob/main/docs/shot.png";
    const media = sourceControlDefinitions.mediaUrl(url)!;
    const layerDrivers = Layer.succeed(BuiltInDrivers.SourceControlDrivers, [
      {
        driver: { kind: media.definition.kind, definition: media.definition },
        instance: fakeSourceControlDriverInstance(media.definition.kind, {
          pullRequests: null,
          fetchMedia: (request) =>
            Effect.sync(() => {
              fetched.push(request);
              return HttpClientResponse.fromWeb(
                HttpClientRequest.get(request.url),
                new Response("bytes", { status: 206, headers: { "content-length": "5" } }),
              );
            }),
        }),
      },
    ]);
    return Effect.gen(function* () {
      const decodeAssetCreateUrlInput = Schema.decodeEffect(AssetCreateUrlInput);

      // Every client and server release spells the resource this way on the wire.
      const { resource } = yield* decodeAssetCreateUrlInput({
        resource: { _tag: "github-media", cwd: "/repo", url },
      });
      const issued = yield* issueAssetUrl({ resource });
      const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const asset = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      expect(asset).toEqual({
        kind: "source-control-media",
        url: media.fetchUrl,
        cwd: "/repo",
        expiresAt: issued.expiresAt,
      });
      if (asset?.kind !== "source-control-media") return;

      const response = yield* sourceControlMediaResponse(asset, {
        range: "bytes=0-4",
        cookie: "session",
      });
      expect(fetched).toEqual([{ url: media.fetchUrl, headers: { range: "bytes=0-4" } }]);
      expect(response.status).toBe(206);
      // The upstream sent no type, so it comes from the file name the host gave the media.
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-length"]).toBe("5");
    }).pipe(Effect.provide(Layer.merge(layerTest, layerDrivers)), Effect.scoped);
  });

  it.effect("refuses media no host keeps behind a credential, without echoing the URL", () =>
    Effect.gen(function* () {
      const encodeAssetAccessError = Schema.encodeEffect(Schema.fromJsonString(AssetAccessError));

      for (const url of [
        "https://example.com/shot.png",
        "https://example.com/shot.png?token=private-media-token",
      ]) {
        const error = yield* issueAssetUrl({
          resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetGitHubMediaUrlValidationError");
        const encoded = yield* encodeAssetAccessError(error);
        expect(encoded).not.toContain(url);
      }
    }).pipe(Effect.provide(layerTest)),
  );
});
