// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- This package is the reviewed Node filesystem and download boundary for app-private provider runtimes; all network and timer dependencies are injectable or bounded at its public API.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import * as Tar from "tar";

import type { ManagedRuntimeArchiveFormat } from "./managedRuntimeArtifact.ts";

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 32;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1_000;

export class ManagedRuntimeFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedRuntimeFileError";
  }
}

function assertAllowedHttpsUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") {
    throw new ManagedRuntimeFileError("Managed runtime downloads must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new ManagedRuntimeFileError("Managed runtime download URLs cannot contain credentials.");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new ManagedRuntimeFileError(
      `Managed runtime download host is not allowed: ${url.hostname}`,
    );
  }
}

async function fetchWithAllowedRedirects(input: {
  readonly url: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly signal: AbortSignal;
}): Promise<Response> {
  let current = new URL(input.url);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertAllowedHttpsUrl(current, input.allowedHosts);
    const response = await fetch(current, { redirect: "manual", signal: input.signal });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new ManagedRuntimeFileError("Managed runtime download redirected without a location.");
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new ManagedRuntimeFileError("Managed runtime download exceeded the redirect limit.");
    }
    current = new URL(location, current);
  }
  throw new ManagedRuntimeFileError("Managed runtime download redirect handling failed.");
}

export async function downloadManagedRuntime(input: {
  readonly url: string;
  readonly destination: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly expectedSize: number;
  readonly signal: AbortSignal;
  readonly onProgress?: (downloaded: number, total: number) => void;
}): Promise<void> {
  const allowedHosts = new Set(input.allowedHosts.map((host) => host.toLowerCase()));
  const idleController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const signal = AbortSignal.any([input.signal, timeoutSignal, idleController.signal]);
  resetIdleTimer();

  try {
    const response = await fetchWithAllowedRedirects({
      url: input.url,
      allowedHosts,
      signal,
    });
    if (!response.ok || !response.body) {
      throw new ManagedRuntimeFileError(
        `Managed runtime download failed with HTTP ${response.status}.`,
      );
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
    if (
      contentLength !== null &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_DOWNLOAD_BYTES ||
        contentLength !== input.expectedSize)
    ) {
      throw new ManagedRuntimeFileError(
        "Managed runtime download size does not match the reviewed catalog.",
      );
    }

    await NodeFSP.mkdir(NodePath.dirname(input.destination), { recursive: true });
    let downloaded = 0;
    const source = NodeStream.Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      downloaded += chunk.byteLength;
      resetIdleTimer();
      if (downloaded > MAX_DOWNLOAD_BYTES || downloaded > input.expectedSize) {
        source.destroy(
          new ManagedRuntimeFileError("Managed runtime download exceeded the reviewed size."),
        );
      }
      input.onProgress?.(downloaded, input.expectedSize);
    });
    try {
      await NodeStreamPromises.pipeline(
        source,
        NodeFS.createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
        {
          signal,
        },
      );
    } catch (cause) {
      await NodeFSP.rm(input.destination, { force: true }).catch(() => undefined);
      throw cause;
    }
    if (downloaded !== input.expectedSize) {
      await NodeFSP.rm(input.destination, { force: true }).catch(() => undefined);
      throw new ManagedRuntimeFileError(
        "Managed runtime download size does not match the reviewed catalog.",
      );
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

export async function verifySha256(filePath: string, expectedDigest: string): Promise<void> {
  const expected = expectedDigest.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new ManagedRuntimeFileError(
      "Managed runtime catalog contains an invalid SHA-256 digest.",
    );
  }
  const hash = NodeCrypto.createHash("sha256");
  const file = await NodeFSP.open(filePath, "r");
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close().catch(() => undefined);
  }
  if (hash.digest("hex") !== expected) {
    throw new ManagedRuntimeFileError("Managed runtime verification failed: checksum mismatch.");
  }
}

function safeArchivePath(root: string, entryPath: string): string {
  const normalized = entryPath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//u.test(normalized)) {
    throw new ManagedRuntimeFileError(`Unsafe archive path: ${entryPath}`);
  }
  const resolved = NodePath.resolve(root, normalized);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new ManagedRuntimeFileError(`Archive entry escapes the destination: ${entryPath}`);
  }
  return resolved;
}

async function extractTarGzip(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  let files = 0;
  let expandedBytes = 0;
  const seen = new Set<string>();
  let validationError: Error | undefined;
  await Tar.x({
    file: input.archivePath,
    cwd: input.destination,
    strict: true,
    preservePaths: false,
    noChmod: true,
    filter: (entryPath, entry) => {
      if (validationError) return false;
      try {
        if (input.signal.aborted) {
          throw new DOMException("Extraction cancelled.", "AbortError");
        }
        safeArchivePath(input.destination, entryPath);
        const normalized = entryPath.replaceAll("\\", "/");
        if (seen.has(normalized)) {
          throw new ManagedRuntimeFileError(`Archive contains a duplicate path: ${entryPath}`);
        }
        seen.add(normalized);
        const entryType = "type" in entry ? entry.type : entry.isDirectory() ? "Directory" : "File";
        if (entryType !== "File" && entryType !== "Directory") {
          throw new ManagedRuntimeFileError(`Unsupported archive entry: ${entryPath}`);
        }
        files += 1;
        expandedBytes += entry.size;
        if (files > MAX_ARCHIVE_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
          throw new ManagedRuntimeFileError("Managed runtime archive exceeds extraction limits.");
        }
        return true;
      } catch (cause) {
        validationError = cause instanceof Error ? cause : new Error(String(cause));
        return false;
      }
    },
  });
  if (validationError) throw validationError;
}

export async function materializeManagedRuntimeArtifact(input: {
  readonly archivePath: string;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  readonly destination: string;
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly signal: AbortSignal;
}): Promise<string> {
  await NodeFSP.mkdir(input.destination, { recursive: true, mode: 0o700 });
  const executable = safeArchivePath(input.destination, input.executablePath);
  if (input.archiveFormat === "raw") {
    await NodeFSP.copyFile(input.archivePath, executable, NodeFS.constants.COPYFILE_EXCL);
  } else {
    await extractTarGzip({
      archivePath: input.archivePath,
      destination: input.destination,
      signal: input.signal,
    });
  }
  const stat = await NodeFSP.lstat(executable).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new ManagedRuntimeFileError(
      "Managed runtime archive did not contain the reviewed executable.",
    );
  }
  if (input.platform !== "win32") await NodeFSP.chmod(executable, 0o755);
  return executable;
}
