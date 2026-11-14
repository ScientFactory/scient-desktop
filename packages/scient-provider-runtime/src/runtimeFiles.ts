// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off globalRandom:off -- This package is the reviewed Node filesystem and download boundary for app-private provider runtimes; all network and timer dependencies are injectable or bounded at its public API, and retry spacing reads the clock and randomness directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeZlib from "node:zlib";

import * as Tar from "tar";
import * as Yauzl from "yauzl";

import type {
  ManagedRuntimeArchiveFormat,
  ManagedRuntimeChecksum,
  ManagedRuntimeExtractionLimits,
} from "./managedRuntimeArtifact.ts";

const MAX_REDIRECTS = 5;
/** Busy or failing servers and gateways; 501 means the server can never do it. */
function isTransientDownloadStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600 && status !== 501);
}
/**
 * Waits before each new try after a failure that is usually temporary: about a
 * minute in all, spread so many installs don't retry at the same moment.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
const MAX_RETRY_AFTER_MS = 60_000;
/** Largest artifact the installer downloads; release discovery rejects larger ones. */
export const MANAGED_RUNTIME_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = MANAGED_RUNTIME_MAX_DOWNLOAD_BYTES;
// Compressed downloads and expanded payloads have independent budgets.
// Providers must explicitly opt in above the unchanged default below.
const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;
const DEFAULT_EXTRACTION_LIMITS: ManagedRuntimeExtractionLimits = {
  maxExpandedBytes: 512 * 1024 * 1024,
  maxEntries: 32,
};
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1_000;
/** A failed try that still brought this much of a resumable download starts the retries afresh. */
const RESUME_PROGRESS_BYTES = 1024 * 1024;

/** Why a runtime install, update or repair failed, as analytics reports it. */
export type ManagedRuntimeFailureClass =
  | "network"
  | "timeout"
  | "http_4xx"
  | "http_5xx"
  | "checksum"
  | "size_mismatch"
  | "certificate"
  | "disk_full"
  | "permission"
  | "extract"
  | "cancelled"
  | "busy"
  | "other";

// @effect-diagnostics-next-line extendsNativeError:off - @scientfactory/provider-runtime has no Effect runtime; callers catch it as a native error.
export class ManagedRuntimeFileError extends Error {
  readonly failureClass: ManagedRuntimeFailureClass | undefined;
  constructor(
    message: string,
    options?: ErrorOptions & { readonly failureClass?: ManagedRuntimeFailureClass },
  ) {
    super(message, options);
    this.name = "ManagedRuntimeFileError";
    this.failureClass = options?.failureClass;
  }
}

function assertAllowedHttpsUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") {
    throw new ManagedRuntimeFileError("Managed runtime downloads must use HTTPS.");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new ManagedRuntimeFileError(
      "Managed runtime downloads must use the standard HTTPS port.",
    );
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

/** A failure another try can fix: a busy server, a dropped connection, a stall. */
// @effect-diagnostics-next-line extendsNativeError:off - internal to the download loop; never leaves this module.
class TransientDownloadFailure extends Error {
  readonly kind: "status" | "connection" | "stalled" | "cut-off";
  /** Short reason for progress text, e.g. `HTTP 504`. */
  readonly reason: string;
  readonly retryAfterMs: number | null;
  readonly status: number | null;
  constructor(
    kind: TransientDownloadFailure["kind"],
    reason: string,
    retryAfterMs: number | null = null,
    options?: ErrorOptions & { readonly status?: number },
  ) {
    super(reason, options);
    this.name = "TransientDownloadFailure";
    this.kind = kind;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
    this.status = options?.status ?? null;
  }
}

const httpFailureClass = (status: number): ManagedRuntimeFailureClass =>
  status >= 500 ? "http_5xx" : "http_4xx";

function transientFailureClass(failure: TransientDownloadFailure): ManagedRuntimeFailureClass {
  switch (failure.kind) {
    case "status":
      return failure.status === null ? "http_5xx" : httpFailureClass(failure.status);
    case "stalled":
      return "timeout";
    case "connection":
    case "cut-off":
      return "network";
  }
}

const SYSTEM_ERROR_CLASSES: Readonly<Record<string, ManagedRuntimeFailureClass>> = {
  ENOSPC: "disk_full",
  EDQUOT: "disk_full",
  EACCES: "permission",
  EPERM: "permission",
  EROFS: "permission",
  ETIMEDOUT: "timeout",
  ECONNRESET: "network",
  ECONNREFUSED: "network",
  ECONNABORTED: "network",
  ENOTFOUND: "network",
  EAI_AGAIN: "network",
  ENETUNREACH: "network",
  EHOSTUNREACH: "network",
  EPIPE: "network",
};
const BUSY_ERROR_NAMES = new Set([
  "ManagedProviderRuntimeBusyError",
  "ManagedProviderRuntimeOwnershipLostError",
  "ManagedRuntimeMutationLockLostError",
]);

/**
 * Classifies a failed install, update or repair from the error types along its cause chain;
 * messages are never read. `stage` is the last progress stage, which places an unclassified
 * file error in extraction.
 */
export function managedRuntimeFailureClass(
  cause: unknown,
  stage?: string,
): ManagedRuntimeFailureClass {
  const chain: unknown[] = [];
  for (let current = cause; current !== undefined && chain.length < 8;) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  const errors = chain.filter((entry): entry is Error => entry instanceof Error);
  for (const error of errors) {
    if (error instanceof ManagedRuntimeFileError && error.failureClass !== undefined)
      return error.failureClass;
    if (error instanceof TransientDownloadFailure) return transientFailureClass(error);
  }
  if (errors.some((error) => error.name === "TimeoutError")) return "timeout";
  if (errors.some((error) => error.name === "AbortError")) return "cancelled";
  for (const error of errors) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const known = code === undefined ? undefined : SYSTEM_ERROR_CLASSES[code];
    if (known !== undefined) return known;
  }
  if (errors.some((error) => BUSY_ERROR_NAMES.has(error.name))) return "busy";
  if (stage === "installing" && errors.some((error) => error instanceof ManagedRuntimeFileError))
    return "extract";
  return "other";
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null;
}

function connectionFailure(cause: unknown): TransientDownloadFailure | ManagedRuntimeFileError {
  const inner = cause instanceof Error ? cause.cause : undefined;
  const code =
    inner instanceof Error && "code" in inner && typeof inner.code === "string"
      ? inner.code
      : undefined;
  // A certificate that doesn't check out stays wrong on every try; it usually
  // means a proxy or security program sits in the middle.
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/u.test(code)) {
    return new ManagedRuntimeFileError(
      `Scient couldn't verify the download server's certificate (${code}). A proxy or security program may be intercepting the connection.`,
      { cause, failureClass: "certificate" },
    );
  }
  return new TransientDownloadFailure(
    "connection",
    code ? `connection failed, ${code}` : "connection failed",
    null,
    { cause },
  );
}

function exhaustedMessage(failure: TransientDownloadFailure, tries: number): string {
  switch (failure.kind) {
    case "status":
      return `The download server returned ${failure.reason} on all ${tries} tries. This is usually temporary; try again in a few minutes.`;
    case "connection":
      return `Scient couldn't reach the download server on all ${tries} tries (${failure.reason}). Check the internet connection, then try again.`;
    case "stalled":
      return `The download stopped receiving data on all ${tries} tries. Check the internet connection, then try again.`;
    case "cut-off":
      return `The download was cut off on all ${tries} tries. Check the internet connection, then try again.`;
  }
}

async function fetchWithAllowedRedirects(input: {
  readonly url: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}): Promise<Response> {
  let current = new URL(input.url);
  let redirectCount = 0;
  for (;;) {
    assertAllowedHttpsUrl(current, input.allowedHosts);
    input.signal.throwIfAborted();
    const response = await fetch(current, {
      redirect: "manual",
      signal: input.signal,
      ...(input.headers ? { headers: input.headers } : {}),
    });
    if (isTransientDownloadStatus(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new TransientDownloadFailure(
        "status",
        `HTTP ${response.status}`,
        retryAfterMs(response.headers.get("retry-after")),
        { status: response.status },
      );
    }
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
    redirectCount += 1;
  }
}

/** Reported before Scient waits to try a failed download again. */
export interface ManagedRuntimeDownloadRetry {
  /** 1 for the first retry. */
  readonly retry: number;
  readonly retries: number;
  /** Short reason, e.g. `HTTP 504`. */
  readonly reason: string;
  readonly delayMs: number;
}

interface ManagedRuntimeDownloadInput {
  readonly url: string;
  /**
   * A second copy of the same release. Any problem with one copy, a missing or
   * damaged file included, moves straight to the other; Scient waits only
   * before going back to a source that already failed.
   */
  readonly fallbackUrl?: string | undefined;
  /** Checked after every try, so a damaged copy counts as that source failing. */
  readonly checksum?: ManagedRuntimeChecksum | undefined;
  readonly destination: string;
  /**
   * Where a failed try keeps its bytes, so the next try or install continues from them.
   * Name it by the release digest: both copies serve the same bytes. Needs `checksum`.
   */
  readonly partialPath?: string | undefined;
  /** Per copy; `null` waits as long as data keeps arriving. Ten minutes by default. */
  readonly timeLimitMs?: number | null | undefined;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly expectedSize: number;
  readonly signal: AbortSignal;
  readonly onProgress?: (downloaded: number, total: number) => void;
  readonly onRetry?: (retry: ManagedRuntimeDownloadRetry) => void;
}

/** What a finished download continued from, for analytics. */
export interface ManagedRuntimeDownloadResult {
  /** Bytes already on disk when the successful try started; 0 for a fresh download. */
  readonly resumedBytes: number;
  /** `fallback` when the second copy served the file. */
  readonly source: "primary" | "fallback";
}

function describeSourceFailure(failure: Error): string {
  if (!(failure instanceof TransientDownloadFailure)) return failure.message;
  switch (failure.kind) {
    case "status":
      return `returned ${failure.reason}.`;
    case "connection":
      return `couldn't be reached (${failure.reason}).`;
    case "stalled":
      return "stopped sending data.";
    case "cut-off":
      return "cut the download off.";
  }
}

/**
 * Downloads one reviewed artifact, retrying temporary failures for about a
 * minute. With a fallback copy, any failure of one copy moves to the other.
 * Cancellation, the time limit and local disk errors always stay final.
 * With `partialPath`, a failed try keeps its bytes and the next try asks only for the rest.
 */
export async function downloadManagedRuntime(
  input: ManagedRuntimeDownloadInput,
): Promise<ManagedRuntimeDownloadResult> {
  const sources = input.fallbackUrl ? [input.url, input.fallbackUrl] : [input.url];
  const allowedHosts = new Set(input.allowedHosts.map((host) => host.toLowerCase()));
  const expected = input.checksum ? expectedDigest(input.checksum) : undefined;
  const partialPath = input.checksum ? input.partialPath : undefined;
  const timeLimitMs = input.timeLimitMs === undefined ? DOWNLOAD_TIMEOUT_MS : input.timeLimitMs;
  // Each copy gets the whole time limit, so a slow copy never uses up the other's.
  const deadlines = new Map<string, AbortSignal>();
  const deadline = (source: string): AbortSignal => {
    const existing = deadlines.get(source);
    if (existing) return existing;
    const created =
      timeLimitMs === null ? new AbortController().signal : AbortSignal.timeout(timeLimitMs);
    deadlines.set(source, created);
    return created;
  };
  const waitSignal =
    sources.length === 1 ? AbortSignal.any([input.signal, deadline(input.url)]) : input.signal;
  const lastFailure = new Map<string, Error>();
  let usable = [...sources];
  let round = [...usable];
  let tries = 0;
  for (let retry = 0; ;) {
    const source = round.shift()!;
    tries += 1;
    const received = { bytes: 0 };
    let cause: unknown;
    try {
      const attempt = await downloadOnce(
        input,
        source,
        allowedHosts,
        deadline(source),
        partialPath,
        received,
      );
      let resumedBytes = attempt.resumedBytes;
      if (expected !== undefined && attempt.digest !== expected) {
        await removePartialDownload(partialPath ?? input.destination);
        // Bytes kept from an earlier try may be what is wrong, so fetch the whole file once.
        if (resumedBytes === 0) throw checksumMismatch();
        const fresh = await downloadOnce(
          input,
          source,
          allowedHosts,
          deadline(source),
          partialPath,
          received,
        );
        if (fresh.digest !== expected) {
          await removePartialDownload(partialPath ?? input.destination);
          throw checksumMismatch();
        }
        resumedBytes = 0;
      }
      if (partialPath) {
        await NodeFSP.rename(partialPath, input.destination);
        await NodeFSP.rm(partialValidatorPath(partialPath), { force: true }).catch(() => undefined);
      }
      return { resumedBytes, source: source === input.url ? "primary" : "fallback" };
    } catch (caught) {
      cause = caught;
    }
    // With a second copy, a problem with this one, running out of time
    // included, only rules this copy out. Cancellation still ends everything.
    const outOfTime = deadline(source).aborted && !input.signal.aborted;
    const ruledOut = sources.length > 1 && (cause instanceof ManagedRuntimeFileError || outOfTime);
    if (!(cause instanceof TransientDownloadFailure) && !ruledOut) {
      if (outOfTime && partialPath && (await partialDownloadSize(partialPath)) > 0) {
        throw new ManagedRuntimeFileError(
          `The download took longer than ${describeTimeLimit(timeLimitMs)}. Scient kept what it downloaded; trying again continues from there.`,
          { cause, failureClass: "timeout" },
        );
      }
      throw cause;
    }
    lastFailure.set(
      source,
      outOfTime
        ? new Error(`took longer than ${describeTimeLimit(timeLimitMs)}.`)
        : (cause as Error),
    );
    if (ruledOut) {
      usable = usable.filter((candidate) => candidate !== source);
      round = round.filter((candidate) => candidate !== source);
    }
    if (usable.length > 0 && round.length > 0) continue;
    // Steady progress on a slow line is not a failing server; keep going while it lasts.
    if (received.bytes >= RESUME_PROGRESS_BYTES) retry = 0;
    const baseDelay = RETRY_DELAYS_MS[retry];
    if (usable.length === 0 || baseDelay === undefined) {
      const kept =
        partialPath && (await partialDownloadSize(partialPath)) > 0
          ? " Scient kept what it downloaded; trying again continues from there."
          : "";
      if (sources.length === 1) {
        throw new ManagedRuntimeFileError(
          `${exhaustedMessage(cause as TransientDownloadFailure, tries)}${kept}`,
          { cause, failureClass: transientFailureClass(cause as TransientDownloadFailure) },
        );
      }
      const details = sources
        .map(
          (candidate) =>
            `${new URL(candidate).hostname} ${describeSourceFailure(lastFailure.get(candidate)!)}`,
        )
        .join(" ");
      throw new ManagedRuntimeFileError(
        `Scient couldn't download it from either source after ${tries} tries. ${details}${kept}`,
        { cause, failureClass: outOfTime ? "timeout" : managedRuntimeFailureClass(cause) },
      );
    }
    const delayMs =
      (cause instanceof TransientDownloadFailure ? cause.retryAfterMs : null) ??
      Math.round(baseDelay * (0.8 + Math.random() * 0.4));
    retry += 1;
    input.onRetry?.({
      retry,
      retries: RETRY_DELAYS_MS.length,
      reason: cause instanceof TransientDownloadFailure ? cause.reason : "download failed",
      delayMs,
    });
    await NodeTimersPromises.setTimeout(delayMs, undefined, { signal: waitSignal });
    round = [...usable];
  }
}

function describeTimeLimit(timeLimitMs: number | null): string {
  const minutes = Math.round((timeLimitMs ?? 0) / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function checksumMismatch(): ManagedRuntimeFileError {
  return new ManagedRuntimeFileError("Managed runtime verification failed: checksum mismatch.", {
    failureClass: "checksum",
  });
}

const partialValidatorPath = (partialPath: string) => `${partialPath}.json`;

async function removePartialDownload(path: string): Promise<void> {
  await NodeFSP.rm(path, { force: true }).catch(() => undefined);
  await NodeFSP.rm(partialValidatorPath(path), { force: true }).catch(() => undefined);
}

async function partialDownloadSize(path: string): Promise<number> {
  const stat = await NodeFSP.stat(path).catch(() => undefined);
  return stat?.isFile() ? stat.size : 0;
}

/** The server's strong ETag for the copy a kept download came from, sent back as `If-Range`. */
async function readPartialValidator(partialPath: string, url: string): Promise<string | undefined> {
  // A sidecar cut short by a crash is only a missing validator; the digest still guards the bytes.
  const saved: unknown = await NodeFSP.readFile(partialValidatorPath(partialPath), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (typeof saved !== "object" || saved === null) return undefined;
  const { url: savedUrl, etag } = saved as { url?: unknown; etag?: unknown };
  return savedUrl === url && typeof etag === "string" ? etag : undefined;
}

async function writePartialValidator(
  partialPath: string,
  url: string,
  response: Response,
): Promise<void> {
  const etag = response.headers.get("etag");
  // Weak validators cannot guard a byte range.
  if (!etag || etag.startsWith("W/")) {
    await NodeFSP.rm(partialValidatorPath(partialPath), { force: true });
    return;
  }
  await NodeFSP.writeFile(partialValidatorPath(partialPath), JSON.stringify({ url, etag }), {
    mode: 0o600,
  });
}

/** True for a `206` that continues exactly at `from` and ends with the reviewed size. */
function continuesAt(response: Response, from: number, expectedSize: number): boolean {
  if (response.status !== 206) return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
  const length = response.headers.get("content-length");
  return (
    range !== null &&
    Number(range[1]) === from &&
    Number(range[2]) === expectedSize - 1 &&
    Number(range[3]) === expectedSize &&
    (length === null || Number(length) === expectedSize - from)
  );
}

async function hashPrefix(path: string, bytes: number, hash: NodeCrypto.Hash): Promise<void> {
  const file = await NodeFSP.open(path, "r");
  try {
    for await (const chunk of file.createReadStream({ start: 0, end: bytes - 1, autoClose: false }))
      hash.update(chunk as Buffer);
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function downloadOnce(
  input: ManagedRuntimeDownloadInput,
  url: string,
  allowedHosts: ReadonlySet<string>,
  timeoutSignal: AbortSignal,
  partialPath: string | undefined,
  received: { bytes: number },
): Promise<{ readonly resumedBytes: number; readonly digest: string | undefined }> {
  const target = partialPath ?? input.destination;
  const newHash = () =>
    input.checksum ? NodeCrypto.createHash(input.checksum.algorithm) : undefined;
  let hash = newHash();
  let have = partialPath ? await partialDownloadSize(partialPath) : 0;
  if (have > input.expectedSize) {
    await removePartialDownload(target);
    have = 0;
  }
  if (have > 0 && hash) await hashPrefix(target, have, hash);
  if (have === input.expectedSize) {
    input.onProgress?.(have, input.expectedSize);
    return { resumedBytes: have, digest: hash?.digest("hex") };
  }

  const idleController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const signal = AbortSignal.any([input.signal, timeoutSignal, idleController.signal]);
  // A stall is worth another try; cancellation and the overall limit are not.
  const classify = (cause: unknown, fromNetwork: boolean): unknown => {
    if (cause instanceof ManagedRuntimeFileError || cause instanceof TransientDownloadFailure)
      return cause;
    if (input.signal.aborted || timeoutSignal.aborted) return cause;
    if (idleController.signal.aborted)
      return new TransientDownloadFailure("stalled", "download stalled", null, { cause });
    return fromNetwork ? connectionFailure(cause) : cause;
  };
  const request = async (from: number) => {
    const validator =
      from > 0 && partialPath ? await readPartialValidator(partialPath, url) : undefined;
    return fetchWithAllowedRedirects({
      url,
      allowedHosts,
      signal,
      ...(from > 0
        ? { headers: { range: `bytes=${from}-`, ...(validator ? { "if-range": validator } : {}) } }
        : {}),
    }).catch((cause: unknown) => {
      throw classify(cause, true);
    });
  };
  resetIdleTimer();

  try {
    let response = await request(have);
    if (have > 0 && !continuesAt(response, have, input.expectedSize)) {
      // A `200` carries the whole file; any other answer is asked again without a range.
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        response = await request(0);
      }
      have = 0;
      hash = newHash();
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new ManagedRuntimeFileError(
        `Managed runtime download failed with HTTP ${response.status}.`,
        { failureClass: httpFailureClass(response.status) },
      );
    }
    if (have === 0) {
      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
      if (
        contentLength !== null &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength < 0 ||
          contentLength > MAX_DOWNLOAD_BYTES ||
          contentLength !== input.expectedSize)
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new ManagedRuntimeFileError(
          "Managed runtime download size does not match the reviewed catalog.",
          { failureClass: "size_mismatch" },
        );
      }
    }

    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    if (partialPath && have === 0) await writePartialValidator(partialPath, url, response);
    let downloaded = have;
    const source = NodeStream.Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      downloaded += chunk.byteLength;
      received.bytes += chunk.byteLength;
      hash?.update(chunk);
      resetIdleTimer();
      if (downloaded > MAX_DOWNLOAD_BYTES || downloaded > input.expectedSize) {
        source.destroy(
          new ManagedRuntimeFileError("Managed runtime download exceeded the reviewed size.", {
            failureClass: "size_mismatch",
          }),
        );
      }
      input.onProgress?.(downloaded, input.expectedSize);
    });
    const file = NodeFS.createWriteStream(target, {
      flags: partialPath ? (have > 0 ? "a" : "w") : "wx",
      mode: 0o600,
    });
    // The pipeline destroys both streams with the first error, so remember
    // which failed first: the response body is the network, the file the disk.
    let failedFirst: "network" | "disk" | undefined;
    source.once("error", () => (failedFirst ??= "network"));
    file.once("error", () => (failedFirst ??= "disk"));
    try {
      await NodeStreamPromises.pipeline(source, file, { signal });
    } catch (cause) {
      // A kept download continues on the next try, unless its bytes cannot be right.
      if (!partialPath || cause instanceof ManagedRuntimeFileError)
        await removePartialDownload(target);
      throw classify(cause, failedFirst === "network");
    }
    if (downloaded !== input.expectedSize) {
      if (!partialPath) await removePartialDownload(target);
      // Fewer bytes than the catalog names means the connection ended early.
      throw new TransientDownloadFailure("cut-off", "download cut off");
    }
    return { resumedBytes: have, digest: hash?.digest("hex") };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function expectedDigest(checksum: ManagedRuntimeChecksum): string {
  const expected = checksum.digest.trim().toLowerCase();
  const expectedLength = checksum.algorithm === "sha256" ? 64 : 128;
  if (!new RegExp(`^[a-f0-9]{${expectedLength}}$`, "u").test(expected)) {
    throw new ManagedRuntimeFileError(
      `Managed runtime catalog contains an invalid ${checksum.algorithm.toUpperCase()} digest.`,
    );
  }
  return expected;
}

export async function verifyManagedRuntimeChecksum(
  filePath: string,
  checksum: ManagedRuntimeChecksum,
): Promise<void> {
  const expected = expectedDigest(checksum);
  const hash = NodeCrypto.createHash(checksum.algorithm);
  const file = await NodeFSP.open(filePath, "r");
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close().catch(() => undefined);
  }
  if (hash.digest("hex") !== expected) throw checksumMismatch();
}

/**
 * The largest zstd window a published copy may use (`zstd --long=27`, 128 MiB); a copy that
 * needs more is refused rather than given more memory.
 */
const ZSTD_WINDOW_LOG_MAX = 27;

/** Whether this process can unpack a zstd copy: Node 22.15 or newer, Electron 44's Node 24. */
export function canUnpackManagedRuntimeZstd(): boolean {
  return typeof NodeZlib.createZstdDecompress === "function";
}

/**
 * Unpacks a downloaded zstd copy into the raw file. Stops as soon as the output passes
 * `expectedSize` and requires exactly that many bytes; the caller still checks the digest.
 */
export async function unpackManagedRuntimeZstd(input: {
  readonly source: string;
  readonly destination: string;
  readonly expectedSize: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  let written = 0;
  const limit = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.byteLength;
      callback(
        written > input.expectedSize
          ? new ManagedRuntimeFileError("The compressed download unpacks to more than its release.")
          : null,
        chunk,
      );
    },
  });
  try {
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(input.source),
      NodeZlib.createZstdDecompress({
        params: { [NodeZlib.constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX },
      }),
      limit,
      NodeFS.createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
      { signal: input.signal },
    );
    if (written !== input.expectedSize) {
      throw new ManagedRuntimeFileError(
        "The compressed download unpacks to less than its release.",
      );
    }
  } catch (cause) {
    await NodeFSP.rm(input.destination, { force: true }).catch(() => undefined);
    if (input.signal.aborted || cause instanceof ManagedRuntimeFileError) throw cause;
    throw new ManagedRuntimeFileError("The compressed download could not be unpacked.", { cause });
  }
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
    resolved.maxExpandedBytes > MAX_EXPANDED_BYTES
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
    throw new ManagedRuntimeFileError(
      `Managed runtime archive exceeds extraction limits at ${JSON.stringify(input.entryPath)}: ` +
        `${input.counters.entries} entries (limit ${input.limits.maxEntries}), ` +
        `${input.counters.expandedBytes} expanded bytes (limit ${input.limits.maxExpandedBytes}).`,
    );
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
