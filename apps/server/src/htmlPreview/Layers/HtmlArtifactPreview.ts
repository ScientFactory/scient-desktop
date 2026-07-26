// FILE: HtmlArtifactPreview.ts
// Purpose: Runs the capability-scoped, loopback-only HTML artifact preview listener.
// Layer: Server HTML-preview live implementation

import crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import Mime from "@effect/platform-node/Mime";
import type {
  ProjectInspectHtmlArtifactInput,
  ProjectPrepareHtmlArtifactPreviewInput,
  ProjectRevokeHtmlArtifactPreviewInput,
} from "@synara/contracts";
import { serializeLocalHtmlCapabilityAuthority } from "@synara/shared/liveHtmlPreviewTransport";
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
  readonly filesByRoute: ReadonlyMap<string, GrantedFile>;
  readonly listenerPort: number;
  readonly thumbnail: boolean;
  readonly dedicatedServer?: http.Server;
}

interface GrantedFile {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(rootPrefix);
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
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
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
): Promise<{
  readonly file: FileHandle;
  readonly path: string;
  readonly stat: Stats;
} | null> {
  const relativePath = decodeRequestedAssetPath(rawUrl);
  if (relativePath === null) return null;
  const granted = grant.filesByRoute.get(relativePath);
  if (!granted) return null;

  // Re-resolve on every request so replacing a granted path with a symlink cannot
  // retarget an already-issued capability. The route map is the authority; the
  // directory containing the HTML is never an implicit file-server root.
  const canonicalFile = await fs.realpath(granted.path).catch(() => null);
  if (canonicalFile !== granted.path) return null;
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const file = await fs.open(granted.path, fsConstants.O_RDONLY | noFollow).catch(() => null);
  if (!file) return null;
  const stat = await file.stat().catch(() => null);
  if (!stat?.isFile() || stat.dev !== granted.device || stat.ino !== granted.inode) {
    await file.close().catch(() => undefined);
    return null;
  }
  return { file, path: granted.path, stat: stat as Stats };
}

function browserHeaders(grant: PreviewGrant): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
    "X-Content-Type-Options": "nosniff",
    ...(grant.thumbnail
      ? {
          "Content-Security-Policy":
            "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
        }
      : {}),
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

function grantedRouteFor(filePath: string, siteRoot: string): string | null {
  const relativePath = path.relative(siteRoot, filePath);
  if (!isPathInside(filePath, siteRoot) || path.isAbsolute(relativePath)) return null;
  return relativePath.split(path.sep).join("/");
}

async function buildGrantedFileRoutes(input: {
  entryPath: string;
  siteRoot: string;
  resourcePaths: readonly string[];
}): Promise<ReadonlyMap<string, GrantedFile>> {
  const routes = new Map<string, GrantedFile>();
  const addRoute = async (route: string, filePath: string) => {
    if (route.split("/").some((segment) => segment.startsWith("."))) return;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) return;
    routes.set(route, { path: filePath, device: stat.dev, inode: stat.ino });
  };

  for (const filePath of [input.entryPath, ...input.resourcePaths]) {
    const route = grantedRouteFor(filePath, input.siteRoot);
    if (route === null) continue;
    await addRoute(route, filePath);
    if (path.basename(filePath).toLowerCase() === "index.html") {
      const directoryRoute = route.slice(0, -"index.html".length).replace(/\/$/, "");
      await addRoute(directoryRoute, filePath);
      await addRoute(directoryRoute.length > 0 ? `${directoryRoute}/` : "", filePath);
    }
  }

  // The capability URL itself always opens the selected entry document. Keep
  // its canonical route too so relative navigation/back-forward remain stable.
  await addRoute("", input.entryPath);
  return routes;
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

export function makeHtmlArtifactPreviewLayer(
  options: {
    readonly maxActiveGrants?: number;
    readonly useDedicatedServers?: boolean;
    readonly capabilitySigningKey?: string;
  } = {},
) {
  const maxActiveGrants = options.maxActiveGrants ?? PREVIEW_MAX_ACTIVE_GRANTS;
  const useDedicatedServers = options.useDedicatedServers ?? process.platform === "win32";
  const inheritedCapabilitySigningKey = process.env.SCIENT_LOCAL_HTML_CAPABILITY_KEY?.trim();
  const capabilitySigningKey = options.capabilitySigningKey ?? inheritedCapabilitySigningKey;
  // Capture the one-run attestation key in this service closure, then remove it
  // before the backend can propagate its environment to provider subprocesses.
  if (!options.capabilitySigningKey && inheritedCapabilitySigningKey) {
    delete process.env.SCIENT_LOCAL_HTML_CAPABILITY_KEY;
  }
  return Layer.effect(
    HtmlArtifactPreview,
    Effect.gen(function* () {
      const grants = new Map<string, PreviewGrant>();
      let listenerPort = 0;
      let reservedGrantSlots = 0;

      const reserveGrantCapacity = (): (() => void) => {
        if (grants.size + reservedGrantSlots >= maxActiveGrants) {
          throw new Error("Too many HTML previews are open. Close a preview and try again.");
        }
        reservedGrantSlots += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          reservedGrantSlots -= 1;
        };
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
            const resolvedFile = await resolveGrantedFile(grant, request.url);
            if (!resolvedFile) {
              writeNotFound(response);
              return;
            }
            const { file, path: filePath, stat } = resolvedFile;
            const contentType = contentTypeFor(filePath);
            const range = parseSingleByteRange(request.headers.range, stat.size);
            if (range === "invalid") {
              response.writeHead(416, {
                ...browserHeaders(grant),
                "Content-Range": `bytes */${stat.size}`,
              });
              response.end();
              await file.close().catch(() => undefined);
              return;
            }
            const responseSize = range ? range.end - range.start + 1 : stat.size;
            response.writeHead(range ? 206 : 200, {
              ...browserHeaders(grant),
              "Content-Length": String(responseSize),
              "Content-Type": contentType,
              ...(range
                ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` }
                : {}),
            });
            if (request.method === "HEAD") {
              response.end();
              await file.close().catch(() => undefined);
              return;
            }
            const stream = file.createReadStream(
              range
                ? { start: range.start, end: range.end, autoClose: false }
                : { autoClose: false },
            );
            let fileClosed = false;
            const closeFile = () => {
              if (fileClosed) return;
              fileClosed = true;
              void file.close().catch(() => undefined);
            };
            stream.on("error", () => {
              closeFile();
              response.destroy();
            });
            stream.on("end", closeFile);
            response.on("close", closeFile);
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

      const inspect: HtmlArtifactPreviewShape["inspect"] = (
        input: ProjectInspectHtmlArtifactInput,
      ) =>
        Effect.tryPromise({
          try: async () => (await inspectHtmlArtifact(input)).result,
          catch: (cause) =>
            new HtmlArtifactPreviewError({
              message: "Failed to inspect the HTML artifact.",
              cause,
            }),
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
            const filesByRoute = await buildGrantedFileRoutes({
              entryPath: inspected.absolutePath,
              siteRoot: canonicalSiteRoot,
              resourcePaths: inspected.allowedResourcePaths,
            });
            const releaseGrantReservation = reserveGrantCapacity();
            let dedicatedServer: http.Server | undefined;
            try {
              const id = crypto.randomUUID();
              dedicatedServer = useDedicatedServers ? createServer(id) : undefined;
              const grantListenerPort = dedicatedServer
                ? await listenOnLoopback(dedicatedServer)
                : listenerPort;
              grants.set(id, {
                id,
                entryPath: inspected.absolutePath,
                siteRoot: canonicalSiteRoot,
                filesByRoute,
                listenerPort: grantListenerPort,
                thumbnail: input.thumbnail === true,
                ...(dedicatedServer ? { dedicatedServer } : {}),
              });
              releaseGrantReservation();
              const watchedPaths = [...new Set(inspected.watchedPaths)];
              const allowedExternalUrls =
                inspected.result.mode === "static-document"
                  ? (inspected.allowedExternalUrls ?? [])
                  : [];
              const localHtmlNetworkPolicy =
                inspected.result.mode === "static-document"
                  ? ("reviewed-static" as const)
                  : ("sealed-interactive" as const);
              const previewUrl = dedicatedServer
                ? `http://127.0.0.1:${grantListenerPort}${previewPathFor(inspected.absolutePath, canonicalSiteRoot)}`
                : `http://g-${id}${PREVIEW_HOST_SUFFIX}:${grantListenerPort}${previewPathFor(inspected.absolutePath, canonicalSiteRoot)}`;
              const localHtmlCapabilityProof = capabilitySigningKey
                ? crypto
                    .createHmac("sha256", capabilitySigningKey)
                    .update(
                      serializeLocalHtmlCapabilityAuthority({
                        previewUrl,
                        sourceIdentity: inspected.absolutePath,
                        sourceRoot: canonicalSiteRoot,
                        watchedPaths,
                        allowedExternalUrls,
                        networkPolicy: localHtmlNetworkPolicy,
                      }),
                    )
                    .digest("base64url")
                : undefined;
              return {
                ...inspected.result,
                allowedExternalUrls,
                sourceIdentity: inspected.absolutePath,
                sourceRoot: canonicalSiteRoot,
                watchedPaths,
                watchDiscoveryLimited: inspected.watchDiscoveryLimited,
                localHtmlNetworkPolicy,
                previewUrl,
                ...(localHtmlCapabilityProof ? { localHtmlCapabilityProof } : {}),
              };
            } catch (cause) {
              releaseGrantReservation();
              if (dedicatedServer) await closeServer(dedicatedServer);
              throw cause;
            }
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
}

export const HtmlArtifactPreviewLive = makeHtmlArtifactPreviewLayer();
