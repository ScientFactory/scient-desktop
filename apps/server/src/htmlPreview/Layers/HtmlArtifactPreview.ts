// FILE: HtmlArtifactPreview.ts
// Purpose: Runs the capability-scoped, loopback-only HTML artifact preview listener.
// Layer: Server HTML-preview live implementation

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import Mime from "@effect/platform-node/Mime";
import type {
  ProjectInspectHtmlArtifactInput,
  ProjectPrepareHtmlArtifactPreviewInput,
  ProjectRevokeHtmlArtifactPreviewInput,
} from "@synara/contracts";
import { Effect, Layer } from "effect";

import { inspectHtmlArtifact } from "../Inspector";
import {
  HtmlArtifactPreview,
  HtmlArtifactPreviewError,
  type HtmlArtifactPreviewShape,
} from "../Services/HtmlArtifactPreview";

const PREVIEW_MAX_ACTIVE_GRANTS = 512;
const PREVIEW_HOST_SUFFIX = ".preview.localhost";

interface PreviewGrant {
  readonly id: string;
  readonly entryPath: string;
  readonly siteRoot: string;
  readonly listenerPort: number;
  readonly dedicatedServer?: http.Server;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    default:
      return Mime.getType(filePath) ?? "application/octet-stream";
  }
}

function writeNotFound(response: http.ServerResponse): void {
  response.writeHead(404, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end("Not Found");
}

function normalizedHostName(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const hostname = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  return hostname.length > 0 ? hostname : null;
}

function grantIdFromHost(hostHeader: string | undefined): string | null {
  const hostname = normalizedHostName(hostHeader);
  if (!hostname?.startsWith("g-") || !hostname.endsWith(PREVIEW_HOST_SUFFIX)) return null;
  const grantId = hostname.slice(2, -PREVIEW_HOST_SUFFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grantId)
    ? grantId
    : null;
}

function decodeRequestedAssetPath(rawUrl: string | undefined): string | null {
  const rawPathname = (rawUrl ?? "").split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("%")) return null;
  const relativePath = decoded.replace(/^\/+/, "");
  if (relativePath.length > 8_192) return null;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
    return null;
  }
  return relativePath;
}

async function resolveGrantedFile(
  grant: PreviewGrant,
  rawUrl: string | undefined,
): Promise<string | null> {
  const relativePath = decodeRequestedAssetPath(rawUrl);
  if (relativePath === null) return null;
  const candidate =
    relativePath.length === 0 ? grant.entryPath : path.resolve(grant.siteRoot, relativePath);
  let canonicalFile = await fs.realpath(candidate).catch(() => null);
  if (!canonicalFile || !isPathInside(canonicalFile, grant.siteRoot)) return null;
  let stat = await fs.stat(canonicalFile).catch(() => null);
  if (stat?.isDirectory()) {
    canonicalFile = await fs.realpath(path.join(canonicalFile, "index.html")).catch(() => null);
    if (!canonicalFile || !isPathInside(canonicalFile, grant.siteRoot)) return null;
    stat = await fs.stat(canonicalFile).catch(() => null);
  }
  return stat?.isFile() ? canonicalFile : null;
}

function browserHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
}

function parseSingleByteRange(
  value: string | undefined,
  sizeBytes: number,
): { readonly start: number; readonly end: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || sizeBytes <= 0) return "invalid";
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, sizeBytes - suffixLength), end: sizeBytes - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= sizeBytes
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

function previewPathFor(entryPath: string, siteRoot: string): string {
  const relativePath = path.relative(siteRoot, entryPath);
  if (!relativePath || relativePath === path.basename(entryPath)) return "/";
  return `/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (port <= 0) {
        reject(new Error("The listener did not expose a usable port."));
        return;
      }
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}

export const HtmlArtifactPreviewLive = Layer.effect(
  HtmlArtifactPreview,
  Effect.gen(function* () {
    const grants = new Map<string, PreviewGrant>();
    let listenerPort = 0;

    const removeGrant = (id: string): boolean => {
      const grant = grants.get(id);
      if (!grant) return false;
      grants.delete(id);
      if (grant.dedicatedServer) {
        void closeServer(grant.dedicatedServer);
      }
      return true;
    };

    const reserveGrantCapacity = (): void => {
      while (grants.size >= PREVIEW_MAX_ACTIVE_GRANTS) {
        const oldestId = grants.keys().next().value as string | undefined;
        if (!oldestId) break;
        removeGrant(oldestId);
      }
    };

    const createServer = (dedicatedGrantId?: string): http.Server =>
      http.createServer((request, response) => {
        void (async () => {
          if (request.method !== "GET" && request.method !== "HEAD") {
            writeNotFound(response);
            return;
          }
          const grantId = dedicatedGrantId
            ? normalizedHostName(request.headers.host) === "127.0.0.1"
              ? dedicatedGrantId
              : null
            : grantIdFromHost(request.headers.host);
          const grant = grantId ? grants.get(grantId) : undefined;
          if (!grant) {
            writeNotFound(response);
            return;
          }
          const filePath = await resolveGrantedFile(grant, request.url);
          if (!filePath) {
            writeNotFound(response);
            return;
          }
          const stat = await fs.stat(filePath).catch(() => null);
          if (!stat?.isFile()) {
            writeNotFound(response);
            return;
          }
          const contentType = contentTypeFor(filePath);
          const range = parseSingleByteRange(request.headers.range, stat.size);
          if (range === "invalid") {
            response.writeHead(416, {
              ...browserHeaders(),
              "Content-Range": `bytes */${stat.size}`,
            });
            response.end();
            return;
          }
          const responseSize = range ? range.end - range.start + 1 : stat.size;
          response.writeHead(range ? 206 : 200, {
            ...browserHeaders(),
            "Content-Length": String(responseSize),
            "Content-Type": contentType,
            ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` } : {}),
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const file = await fs.open(filePath, "r");
          const stream = file.createReadStream(
            range ? { start: range.start, end: range.end } : undefined,
          );
          stream.on("error", () => response.destroy());
          stream.on("close", () => void file.close().catch(() => undefined));
          stream.pipe(response);
        })().catch(() => {
          if (!response.headersSent) writeNotFound(response);
          else response.destroy();
        });
      });

    const server = createServer();

    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          listenerPort = await listenOnLoopback(server);
        },
        catch: (cause) =>
          new HtmlArtifactPreviewError({
            message: "Failed to start the local HTML preview listener.",
            cause,
          }),
      }),
      () =>
        Effect.promise(async () => {
          const dedicatedServers = [...grants.values()].flatMap((grant) =>
            grant.dedicatedServer ? [grant.dedicatedServer] : [],
          );
          grants.clear();
          await Promise.all([closeServer(server), ...dedicatedServers.map(closeServer)]);
        }),
    );

    const inspect: HtmlArtifactPreviewShape["inspect"] = (input: ProjectInspectHtmlArtifactInput) =>
      Effect.tryPromise({
        try: async () => (await inspectHtmlArtifact(input)).result,
        catch: (cause) =>
          new HtmlArtifactPreviewError({ message: "Failed to inspect the HTML artifact.", cause }),
      });

    const prepare: HtmlArtifactPreviewShape["prepare"] = (
      input: ProjectPrepareHtmlArtifactPreviewInput,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const inspected = await inspectHtmlArtifact(input);
          if (
            !inspected.absolutePath ||
            !inspected.baseDirectory ||
            !inspected.siteRoot ||
            (inspected.result.mode !== "static-document" &&
              inspected.result.mode !== "interactive-bundle")
          ) {
            return inspected.result;
          }
          const canonicalSiteRoot = await fs.realpath(inspected.siteRoot);
          reserveGrantCapacity();
          const id = crypto.randomUUID();
          const dedicatedServer = process.platform === "win32" ? createServer(id) : undefined;
          const grantListenerPort = dedicatedServer
            ? await listenOnLoopback(dedicatedServer)
            : listenerPort;
          grants.set(id, {
            id,
            entryPath: inspected.absolutePath,
            siteRoot: canonicalSiteRoot,
            listenerPort: grantListenerPort,
            ...(dedicatedServer ? { dedicatedServer } : {}),
          });
          return {
            ...inspected.result,
            previewUrl: dedicatedServer
              ? `http://127.0.0.1:${grantListenerPort}${previewPathFor(inspected.absolutePath, canonicalSiteRoot)}`
              : `http://g-${id}${PREVIEW_HOST_SUFFIX}:${grantListenerPort}${previewPathFor(inspected.absolutePath, canonicalSiteRoot)}`,
          };
        },
        catch: (cause) =>
          new HtmlArtifactPreviewError({
            message: "Failed to prepare the HTML artifact preview.",
            cause,
          }),
      });

    const revoke: HtmlArtifactPreviewShape["revoke"] = (
      input: ProjectRevokeHtmlArtifactPreviewInput,
    ) =>
      Effect.promise(async () => {
        try {
          const previewUrl = new URL(input.previewUrl);
          const grantId =
            grantIdFromHost(previewUrl.host) ??
            (previewUrl.hostname === "127.0.0.1"
              ? ([...grants.values()].find(
                  (grant) =>
                    grant.dedicatedServer && String(grant.listenerPort) === previewUrl.port,
                )?.id ?? null)
              : null);
          const grant = grantId ? grants.get(grantId) : undefined;
          if (!grant || String(grant.listenerPort) !== previewUrl.port) {
            return { revoked: false };
          }
          grants.delete(grant.id);
          if (grant.dedicatedServer) {
            await closeServer(grant.dedicatedServer);
          }
          return { revoked: true };
        } catch {
          return { revoked: false };
        }
      });

    return HtmlArtifactPreview.of({ inspect, prepare, revoke });
  }),
);
