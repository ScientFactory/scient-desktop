// FILE: HtmlArtifactPreview.ts
// Purpose: Runs the capability-scoped, loopback-only HTML artifact preview listener.
// Layer: Server HTML-preview live implementation

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type {
  ProjectHtmlArtifactMode,
  ProjectInspectHtmlArtifactInput,
  ProjectPrepareHtmlArtifactPreviewInput,
  ProjectRevokeHtmlArtifactPreviewInput,
} from "@synara/contracts";
import { SUPPORTED_LOCAL_IMAGE_EXTENSIONS } from "@synara/shared/localPreviewFiles";
import { Effect, Layer } from "effect";

import { inspectHtmlArtifact } from "../Inspector";
import {
  HtmlArtifactPreview,
  HtmlArtifactPreviewError,
  type HtmlArtifactPreviewShape,
} from "../Services/HtmlArtifactPreview";

const PREVIEW_GRANT_TTL_MS = 15 * 60 * 1000;
const PREVIEW_MAX_ACTIVE_GRANTS = 128;
const PREVIEW_MAX_ASSET_BYTES = 25 * 1024 * 1024;
const PREVIEW_HOST_SUFFIX = ".preview.localhost";
const PREVIEW_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);
const STATIC_PREVIEW_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  [...PREVIEW_ASSET_EXTENSIONS].filter((extension) => extension !== ".js" && extension !== ".mjs"),
);

function executableHtmlPreviewEnabled(): boolean {
  const value = process.env.SCIENT_EXECUTABLE_HTML_PREVIEW?.trim().toLowerCase();
  return value === "1" || value === "true";
}

interface PreviewGrant {
  readonly id: string;
  readonly entryPath: string;
  readonly baseDirectory: string;
  readonly mode: Extract<ProjectHtmlArtifactMode, "static-document" | "interactive-bundle">;
  readonly expiresAtMs: number;
  readonly allowedFiles: ReadonlySet<string>;
  readonly listenerPort: number;
  readonly dedicatedServer?: http.Server;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function previewContentSecurityPolicy(mode: PreviewGrant["mode"]): string {
  const executable = mode === "interactive-bundle";
  return [
    "default-src 'none'",
    executable ? "script-src 'self' 'unsafe-inline'" : "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'none'",
    executable ? "connect-src 'self'" : "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors http://localhost:* http://127.0.0.1:* scient:",
    executable ? "sandbox allow-scripts allow-same-origin" : "sandbox",
  ].join("; ");
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
      return "application/octet-stream";
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
  if (relativePath.length > 2_048) return null;
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
  if (relativePath.length === 0) return grant.entryPath;

  const extension = path.extname(relativePath).toLowerCase();
  const allowedExtensions =
    grant.mode === "interactive-bundle"
      ? PREVIEW_ASSET_EXTENSIONS
      : STATIC_PREVIEW_ASSET_EXTENSIONS;
  if (!allowedExtensions.has(extension)) return null;

  const candidate = path.resolve(grant.baseDirectory, relativePath);
  const canonicalFile = await fs.realpath(candidate).catch(() => null);
  if (!canonicalFile || !isPathInside(canonicalFile, grant.baseDirectory)) return null;
  if (!grant.allowedFiles.has(canonicalFile)) return null;
  const stat = await fs.stat(canonicalFile).catch(() => null);
  return stat?.isFile() && stat.size <= PREVIEW_MAX_ASSET_BYTES ? canonicalFile : null;
}

function securityHeaders(grant: PreviewGrant): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": previewContentSecurityPolicy(grant.mode),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), payment=(), usb=(), serial=(), hid=(), clipboard-read=(), clipboard-write=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
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

    const pruneExpiredGrants = (nowMs: number): void => {
      for (const [id, grant] of grants) {
        if (grant.expiresAtMs <= nowMs) removeGrant(id);
      }
    };

    const reserveGrantCapacity = (nowMs: number): void => {
      pruneExpiredGrants(nowMs);
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
          const nowMs = Date.now();
          pruneExpiredGrants(nowMs);
          const grantId = dedicatedGrantId
            ? normalizedHostName(request.headers.host) === "127.0.0.1"
              ? dedicatedGrantId
              : null
            : grantIdFromHost(request.headers.host);
          const grant = grantId ? grants.get(grantId) : undefined;
          if (!grant || grant.expiresAtMs <= nowMs) {
            writeNotFound(response);
            return;
          }
          const filePath = await resolveGrantedFile(grant, request.url);
          if (!filePath) {
            writeNotFound(response);
            return;
          }
          const stat = await fs.stat(filePath).catch(() => null);
          if (!stat?.isFile() || stat.size > PREVIEW_MAX_ASSET_BYTES) {
            writeNotFound(response);
            return;
          }
          response.writeHead(200, {
            ...securityHeaders(grant),
            "Content-Length": String(stat.size),
            "Content-Type": contentTypeFor(filePath),
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const file = await fs.open(filePath, "r");
          const stream = file.createReadStream();
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
            message: "Failed to start the isolated HTML preview listener.",
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
            !executableHtmlPreviewEnabled() &&
            (inspected.result.mode === "interactive-bundle" ||
              inspected.result.mode === "dev-server-entrypoint")
          ) {
            const { runTarget: _runTarget, ...inspectionWithoutRunTarget } = inspected.result;
            return {
              ...inspectionWithoutRunTarget,
              mode: "unsupported" as const,
              reason:
                "Executable HTML previews are disabled by the SCIENT_EXECUTABLE_HTML_PREVIEW rollout switch.",
            };
          }
          if (
            !inspected.absolutePath ||
            !inspected.baseDirectory ||
            (inspected.result.mode !== "static-document" &&
              inspected.result.mode !== "interactive-bundle")
          ) {
            return inspected.result;
          }
          const canonicalBaseDirectory = await fs.realpath(inspected.baseDirectory);
          const nowMs = Date.now();
          reserveGrantCapacity(nowMs);
          const expiresAtMs = nowMs + PREVIEW_GRANT_TTL_MS;
          const id = crypto.randomUUID();
          const dedicatedServer = process.platform === "win32" ? createServer(id) : undefined;
          const grantListenerPort = dedicatedServer
            ? await listenOnLoopback(dedicatedServer)
            : listenerPort;
          grants.set(id, {
            id,
            entryPath: inspected.absolutePath,
            baseDirectory: canonicalBaseDirectory,
            mode: inspected.result.mode,
            expiresAtMs,
            allowedFiles: new Set([inspected.absolutePath, ...inspected.allowedResourcePaths]),
            listenerPort: grantListenerPort,
            ...(dedicatedServer ? { dedicatedServer } : {}),
          });
          return {
            ...inspected.result,
            previewUrl: dedicatedServer
              ? `http://127.0.0.1:${grantListenerPort}/`
              : `http://g-${id}${PREVIEW_HOST_SUFFIX}:${grantListenerPort}/`,
            expiresAt: new Date(expiresAtMs).toISOString(),
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
