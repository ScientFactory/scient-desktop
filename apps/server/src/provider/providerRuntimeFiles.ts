import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS, createWriteStream } from "node:fs";
import FS from "node:fs/promises";
import Path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as Tar from "tar";
import Unzipper from "unzipper";

import type { ProviderRuntimeArchiveFormat } from "./providerRuntimeTypes";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000;

export class ProviderRuntimeFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderRuntimeFileError";
  }
}

function assertAllowedHttpsUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") {
    throw new ProviderRuntimeFileError("Provider runtime downloads must use HTTPS.");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new ProviderRuntimeFileError(
      `Provider runtime download host is not allowed: ${url.hostname}`,
    );
  }
  if (url.username || url.password) {
    throw new ProviderRuntimeFileError(
      "Provider runtime download URLs cannot contain credentials.",
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
    if (!location) {
      throw new ProviderRuntimeFileError(
        "Provider runtime download redirected without a location.",
      );
    }
    if (redirectCount === MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderRuntimeFileError("Provider runtime download exceeded the redirect limit.");
    }
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current);
  }
  throw new ProviderRuntimeFileError("Provider runtime download failed while following redirects.");
}

export async function downloadProviderRuntime(input: {
  readonly url: string;
  readonly destination: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly signal: AbortSignal;
  readonly expectedSize?: number;
  readonly maxBytes?: number;
  readonly onProgress?: (downloaded: number, total: number | null) => void;
}): Promise<{ readonly bytes: number }> {
  const allowedHosts = new Set(input.allowedHosts.map((host) => host.toLowerCase()));
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const idleController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const signal = AbortSignal.any([input.signal, timeoutSignal, idleController.signal]);
  resetIdleTimer();
  let response: Response;
  try {
    response = await fetchWithAllowedRedirects({
      url: input.url,
      allowedHosts,
      signal,
    });
  } catch (cause) {
    if (idleTimer) clearTimeout(idleTimer);
    throw cause;
  }
  if (!response.ok || !response.body) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new ProviderRuntimeFileError(
      `Provider runtime download failed with HTTP ${response.status}.`,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new ProviderRuntimeFileError("Provider runtime download returned an invalid size.");
  }
  if (contentLength !== null && contentLength > maxBytes) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new ProviderRuntimeFileError(
      "Provider runtime download is larger than the allowed limit.",
    );
  }
  if (
    input.expectedSize !== undefined &&
    contentLength !== null &&
    contentLength !== input.expectedSize
  ) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new ProviderRuntimeFileError(
      "Provider runtime download size does not match the catalog.",
    );
  }

  await FS.mkdir(Path.dirname(input.destination), { recursive: true });
  let downloaded = 0;
  try {
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      downloaded += chunk.byteLength;
      resetIdleTimer();
      if (downloaded > maxBytes)
        source.destroy(
          new ProviderRuntimeFileError("Provider runtime download exceeded the allowed size."),
        );
      input.onProgress?.(downloaded, contentLength);
    });
    await pipeline(source, createWriteStream(input.destination, { flags: "wx", mode: 0o600 }), {
      signal,
    });
  } catch (cause) {
    await FS.rm(input.destination, { force: true }).catch(() => undefined);
    throw cause;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (input.expectedSize !== undefined && downloaded !== input.expectedSize) {
    await FS.rm(input.destination, { force: true }).catch(() => undefined);
    throw new ProviderRuntimeFileError(
      "Provider runtime download size does not match the catalog.",
    );
  }
  return { bytes: downloaded };
}

export async function hashFile(filePath: string, algorithm: "sha256" | "sha512"): Promise<string> {
  const hash = createHash(algorithm);
  const file = await FS.open(filePath, "r");
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close().catch(() => undefined);
  }
  return hash.digest("hex");
}

export async function verifyProviderRuntimeDigest(input: {
  readonly filePath: string;
  readonly algorithm: "sha256" | "sha512";
  readonly expectedDigest: string;
}): Promise<void> {
  const expected = input.expectedDigest.trim().toLowerCase();
  if (
    !/^[a-f0-9]+$/u.test(expected) ||
    expected.length !== (input.algorithm === "sha256" ? 64 : 128)
  ) {
    throw new ProviderRuntimeFileError("Provider runtime catalog contains an invalid digest.");
  }
  const actual = await hashFile(input.filePath, input.algorithm);
  if (actual !== expected) {
    throw new ProviderRuntimeFileError("Provider runtime verification failed: checksum mismatch.");
  }
}

function safeArchivePath(root: string, entryPath: string): string {
  const normalized = entryPath.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//u.test(normalized)) {
    throw new ProviderRuntimeFileError(`Unsafe archive path: ${entryPath}`);
  }
  const resolved = Path.resolve(root, normalized);
  const relative = Path.relative(root, resolved);
  if (relative.startsWith("..") || Path.isAbsolute(relative)) {
    throw new ProviderRuntimeFileError(`Archive entry escapes the destination: ${entryPath}`);
  }
  return resolved;
}

async function extractTarGzip(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly maxFiles: number;
  readonly maxExpandedBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  let files = 0;
  let expandedBytes = 0;
  const seen = new Set<string>();
  let validationError: ProviderRuntimeFileError | DOMException | null = null;
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
          validationError = new DOMException("Extraction cancelled.", "AbortError");
          return false;
        }
        safeArchivePath(input.destination, entryPath);
        const normalized = entryPath.replaceAll("\\", "/");
        if (seen.has(normalized)) {
          validationError = new ProviderRuntimeFileError(
            `Provider runtime archive contains a duplicate path: ${entryPath}`,
          );
          return false;
        }
        seen.add(normalized);
        const entryType = "type" in entry ? entry.type : entry.isDirectory() ? "Directory" : "File";
        if (entryType !== "File" && entryType !== "Directory") {
          validationError = new ProviderRuntimeFileError(
            `Unsupported provider runtime archive entry: ${entryPath}`,
          );
          return false;
        }
        files += 1;
        expandedBytes += entry.size;
        if (files > input.maxFiles || expandedBytes > input.maxExpandedBytes) {
          validationError = new ProviderRuntimeFileError(
            "Provider runtime archive exceeds extraction limits.",
          );
          return false;
        }
        return true;
      } catch (cause) {
        validationError =
          cause instanceof ProviderRuntimeFileError
            ? cause
            : new ProviderRuntimeFileError("Provider runtime archive validation failed.", {
                cause,
              });
        return false;
      }
    },
  });
  if (validationError) throw validationError;
}

async function extractZip(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly maxFiles: number;
  readonly maxExpandedBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  const archive = await Unzipper.Open.file(input.archivePath);
  if (archive.files.length > input.maxFiles) {
    throw new ProviderRuntimeFileError("Provider runtime archive contains too many files.");
  }
  const expandedBytes = archive.files.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (expandedBytes > input.maxExpandedBytes) {
    throw new ProviderRuntimeFileError("Provider runtime archive exceeds extraction limits.");
  }

  let actualExpandedBytes = 0;
  const seen = new Set<string>();
  for (const entry of archive.files) {
    if (input.signal.aborted) throw new DOMException("Extraction cancelled.", "AbortError");
    const destination = safeArchivePath(input.destination, entry.path);
    const normalized = entry.path.replaceAll("\\", "/");
    if (seen.has(normalized)) {
      throw new ProviderRuntimeFileError(
        `Provider runtime archive contains a duplicate path: ${entry.path}`,
      );
    }
    seen.add(normalized);
    const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new ProviderRuntimeFileError(
        "Provider runtime archives cannot contain symbolic links.",
      );
    }
    if (entry.type === "Directory") {
      await FS.mkdir(destination, { recursive: true });
      continue;
    }
    if (entry.type !== "File") {
      throw new ProviderRuntimeFileError(
        `Unsupported provider runtime archive entry: ${entry.path}`,
      );
    }
    await FS.mkdir(Path.dirname(destination), { recursive: true });
    const output = await FS.open(destination, "wx", 0o600);
    try {
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          actualExpandedBytes += chunk.byteLength;
          if (actualExpandedBytes > input.maxExpandedBytes) {
            callback(
              new ProviderRuntimeFileError("Provider runtime archive exceeds extraction limits."),
            );
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(entry.stream(), limiter, output.createWriteStream({ autoClose: false }), {
        signal: input.signal,
      });
    } finally {
      await output.close().catch(() => undefined);
    }
  }
}

export async function extractProviderRuntime(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly format: ProviderRuntimeArchiveFormat;
  readonly executablePath: string;
  readonly maxFiles?: number;
  readonly maxExpandedBytes?: number;
  readonly signal: AbortSignal;
}): Promise<string> {
  await FS.mkdir(input.destination, { recursive: true });
  const executable = safeArchivePath(input.destination, input.executablePath);
  if (input.format === "raw") {
    await FS.mkdir(Path.dirname(executable), { recursive: true });
    if (input.signal.aborted) throw new DOMException("Extraction cancelled.", "AbortError");
    await FS.copyFile(input.archivePath, executable, FS_CONSTANTS.COPYFILE_EXCL);
  } else if (input.format === "tar.gz") {
    await extractTarGzip({
      archivePath: input.archivePath,
      destination: input.destination,
      maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES,
      maxExpandedBytes: input.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES,
      signal: input.signal,
    });
  } else {
    await extractZip({
      archivePath: input.archivePath,
      destination: input.destination,
      maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES,
      maxExpandedBytes: input.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES,
      signal: input.signal,
    });
  }

  const stat = await FS.stat(executable).catch(() => null);
  if (!stat?.isFile()) {
    throw new ProviderRuntimeFileError(
      "Provider runtime archive does not contain the expected executable.",
    );
  }
  if (process.platform !== "win32") await FS.chmod(executable, 0o700);
  return executable;
}
