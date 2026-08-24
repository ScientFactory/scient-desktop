// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off -- This package is the reviewed Node filesystem and download boundary for app-private provider runtimes; all network and timer dependencies are injectable or bounded at its public API.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import * as Tar from "tar";
import * as Yauzl from "yauzl";

import type {
  ManagedRuntimeArchiveFormat,
  ManagedRuntimeChecksum,
  ManagedRuntimeExtractionLimits,
} from "./managedRuntimeArtifact.ts";

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_EXTRACTION_LIMITS: ManagedRuntimeExtractionLimits = {
  maxExpandedBytes: 512 * 1024 * 1024,
  maxEntries: 32,
};
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

export async function verifyManagedRuntimeChecksum(
  filePath: string,
  checksum: ManagedRuntimeChecksum,
): Promise<void> {
  const expected = checksum.digest.trim().toLowerCase();
  const expectedLength = checksum.algorithm === "sha256" ? 64 : 128;
  if (!new RegExp(`^[a-f0-9]{${expectedLength}}$`, "u").test(expected)) {
    throw new ManagedRuntimeFileError(
      `Managed runtime catalog contains an invalid ${checksum.algorithm.toUpperCase()} digest.`,
    );
  }
  const hash = NodeCrypto.createHash(checksum.algorithm);
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

export async function verifySha256(filePath: string, expectedDigest: string): Promise<void> {
  return verifyManagedRuntimeChecksum(filePath, {
    algorithm: "sha256",
    digest: expectedDigest,
  });
}

function validatedExtractionLimits(
  limits: ManagedRuntimeExtractionLimits | undefined,
): ManagedRuntimeExtractionLimits {
  const resolved = limits ?? DEFAULT_EXTRACTION_LIMITS;
  if (
    !Number.isSafeInteger(resolved.maxEntries) ||
    resolved.maxEntries < 1 ||
    !Number.isSafeInteger(resolved.maxExpandedBytes) ||
    resolved.maxExpandedBytes < 1 ||
    resolved.maxExpandedBytes > MAX_DOWNLOAD_BYTES
  ) {
    throw new ManagedRuntimeFileError(
      "Managed runtime catalog contains invalid extraction limits.",
    );
  }
  return resolved;
}

export function resolveManagedRuntimeArtifactPath(root: string, entryPath: string): string {
  const normalized = entryPath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    segments.includes("..")
  ) {
    throw new ManagedRuntimeFileError(`Unsafe archive path: ${entryPath}`);
  }
  const resolved = NodePath.resolve(root, normalized);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new ManagedRuntimeFileError(`Archive entry escapes the destination: ${entryPath}`);
  }
  return resolved;
}

function canonicalArchiveEntryPath(entryPath: string, platform: NodeJS.Platform): string {
  const normalized = NodePath.posix.normalize(entryPath.replaceAll("\\", "/")).replace(/\/+$/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateArchiveEntry(input: {
  readonly destination: string;
  readonly entryPath: string;
  readonly entrySize: number;
  readonly platform: NodeJS.Platform;
  readonly limits: ManagedRuntimeExtractionLimits;
  readonly seen: Set<string>;
  readonly counters: { entries: number; expandedBytes: number };
}): string {
  if (!Number.isSafeInteger(input.entrySize) || input.entrySize < 0) {
    throw new ManagedRuntimeFileError(`Archive entry has an invalid size: ${input.entryPath}`);
  }
  const outputPath = resolveManagedRuntimeArtifactPath(input.destination, input.entryPath);
  const canonical = canonicalArchiveEntryPath(input.entryPath, input.platform);
  if (!canonical || input.seen.has(canonical)) {
    throw new ManagedRuntimeFileError(`Archive contains a duplicate path: ${input.entryPath}`);
  }
  if (input.platform === "win32" && canonical.includes(":")) {
    throw new ManagedRuntimeFileError(`Unsafe Windows archive path: ${input.entryPath}`);
  }
  input.seen.add(canonical);
  input.counters.entries += 1;
  input.counters.expandedBytes += input.entrySize;
  if (
    input.counters.entries > input.limits.maxEntries ||
    input.counters.expandedBytes > input.limits.maxExpandedBytes
  ) {
    throw new ManagedRuntimeFileError("Managed runtime archive exceeds extraction limits.");
  }
  return outputPath;
}

async function extractTarGzip(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly platform: NodeJS.Platform;
  readonly limits: ManagedRuntimeExtractionLimits;
  readonly signal: AbortSignal;
}): Promise<void> {
  const seen = new Set<string>();
  const counters = { entries: 0, expandedBytes: 0 };
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
        const entryType = "type" in entry ? entry.type : entry.isDirectory() ? "Directory" : "File";
        if (entryType !== "File" && entryType !== "Directory") {
          throw new ManagedRuntimeFileError(`Unsupported archive entry: ${entryPath}`);
        }
        validateArchiveEntry({
          destination: input.destination,
          entryPath,
          entrySize: entry.size,
          platform: input.platform,
          limits: input.limits,
          seen,
          counters,
        });
        return true;
      } catch (cause) {
        validationError = cause instanceof Error ? cause : new Error(String(cause));
        return false;
      }
    },
  });
  if (validationError) throw validationError;
}

function openZipFile(archivePath: string): Promise<Yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    Yauzl.open(
      archivePath,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error) reject(error);
        else resolve(zipFile);
      },
    );
  });
}

function openZipEntryStream(
  zipFile: Yauzl.ZipFile,
  entry: Yauzl.Entry,
): Promise<NodeStream.Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function zipEntryKind(entry: Yauzl.Entry): "file" | "directory" {
  if (entry.isEncrypted()) {
    throw new ManagedRuntimeFileError(
      `Encrypted archive entry is not supported: ${entry.fileName}`,
    );
  }
  const isDirectory = entry.fileName.endsWith("/");
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (unixType === 0o120000) {
    throw new ManagedRuntimeFileError(`Unsupported archive entry: ${entry.fileName}`);
  }
  if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) {
    throw new ManagedRuntimeFileError(`Unsupported archive entry: ${entry.fileName}`);
  }
  if ((unixType === 0o040000) !== isDirectory && unixType !== 0) {
    throw new ManagedRuntimeFileError(`Archive entry type is inconsistent: ${entry.fileName}`);
  }
  return isDirectory ? "directory" : "file";
}

async function extractZip(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly platform: NodeJS.Platform;
  readonly limits: ManagedRuntimeExtractionLimits;
  readonly signal: AbortSignal;
}): Promise<void> {
  const zipFile = await openZipFile(input.archivePath).catch((cause) => {
    throw new ManagedRuntimeFileError("Managed runtime ZIP archive could not be opened.", {
      cause,
    });
  });
  const seen = new Set<string>();
  const counters = { entries: 0, expandedBytes: 0 };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      zipFile.once("error", finish);
      zipFile.once("end", () => finish());
      zipFile.on("entry", (entry: Yauzl.Entry) => {
        void (async () => {
          if (input.signal.aborted) {
            throw new DOMException("Extraction cancelled.", "AbortError");
          }
          if (entry.fileName.includes("\\")) {
            throw new ManagedRuntimeFileError(`Unsafe ZIP archive path: ${entry.fileName}`);
          }
          const kind = zipEntryKind(entry);
          const outputPath = validateArchiveEntry({
            destination: input.destination,
            entryPath: entry.fileName,
            entrySize: entry.uncompressedSize,
            platform: input.platform,
            limits: input.limits,
            seen,
            counters,
          });
          if (kind === "directory") {
            await NodeFSP.mkdir(outputPath, { recursive: true, mode: 0o700 });
          } else {
            await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true, mode: 0o700 });
            const stream = await openZipEntryStream(zipFile, entry);
            await NodeStreamPromises.pipeline(
              stream,
              NodeFS.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
              { signal: input.signal },
            );
          }
          if (!settled) zipFile.readEntry();
        })().catch(finish);
      });
      zipFile.readEntry();
    });
  } catch (cause) {
    throw cause instanceof Error
      ? cause
      : new ManagedRuntimeFileError("Managed runtime ZIP extraction failed.", { cause });
  } finally {
    zipFile.close();
  }
}

export async function materializeManagedRuntimeArtifact(input: {
  readonly archivePath: string;
  readonly archiveFormat: ManagedRuntimeArchiveFormat;
  readonly destination: string;
  readonly executablePath: string;
  readonly auxiliaryExecutablePaths?: ReadonlyArray<string> | undefined;
  readonly platform: NodeJS.Platform;
  readonly extractionLimits?: ManagedRuntimeExtractionLimits | undefined;
  readonly signal: AbortSignal;
}): Promise<string> {
  await NodeFSP.mkdir(input.destination, { recursive: true, mode: 0o700 });
  const executable = resolveManagedRuntimeArtifactPath(input.destination, input.executablePath);
  if (input.archiveFormat === "raw") {
    await NodeFSP.copyFile(input.archivePath, executable, NodeFS.constants.COPYFILE_EXCL);
  } else if (input.archiveFormat === "tar.gz") {
    await extractTarGzip({
      archivePath: input.archivePath,
      destination: input.destination,
      platform: input.platform,
      limits: validatedExtractionLimits(input.extractionLimits),
      signal: input.signal,
    });
  } else {
    await extractZip({
      archivePath: input.archivePath,
      destination: input.destination,
      platform: input.platform,
      limits: validatedExtractionLimits(input.extractionLimits),
      signal: input.signal,
    });
  }
  const reviewedExecutables = [input.executablePath, ...(input.auxiliaryExecutablePaths ?? [])];
  for (const reviewedPath of reviewedExecutables) {
    const reviewedExecutable = resolveManagedRuntimeArtifactPath(input.destination, reviewedPath);
    const stat = await NodeFSP.lstat(reviewedExecutable).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new ManagedRuntimeFileError(
        `Managed runtime archive did not contain the reviewed executable: ${reviewedPath}`,
      );
    }
    if (input.platform !== "win32") await NodeFSP.chmod(reviewedExecutable, 0o755);
  }
  return executable;
}
