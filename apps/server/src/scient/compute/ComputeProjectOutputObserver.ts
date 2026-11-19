// @effect-diagnostics nodeBuiltinImport:off -- execution-scoped project outputs are host files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeImageMediaType, ComputeRuntimeWriteReport } from "@scientfactory/compute";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { inspectComputeStaticImage } from "./ComputeStaticImage.ts";
import type { ComputeCaptureReason, ComputeProjectCaptureStatus } from "./ComputeCaptureStatus.ts";
import {
  ENVIRONMENT_MARKERS,
  IGNORED_DIRECTORY_NAMES,
  OUTPUT_FILE,
  makeProjectWriteWatches,
  type ProjectWatchBackend,
  type ProjectWriteMark,
  type ProjectWriteWatch,
  type ProjectWriteWatches,
} from "./ComputeProjectWriteWatch.ts";

const MAXIMUM_IMAGES_PER_EXECUTION = 32;
const MAXIMUM_IMAGE_BYTES = 8 * 1024 * 1024;
// File clocks lag the wall clock by up to a kernel tick, and FAT keeps times to two seconds.
const FINE_TIME_SLACK_NS = 50_000_000n;
const COARSE_TIME_SLACK_NS = 2_000_000_000n;
const FALLBACK_SCAN_ENTRIES = 16_384;
const FALLBACK_SCAN_TIME_MS = 750;
const CREATED_DIRECTORY_ENTRIES = 1_024;
const MAXIMUM_REMEMBERED_OUTPUTS = 1_024;

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(IGNORED_DIRECTORY_NAMES);

export interface ComputeProjectOutputObservation {
  readonly projectRoot: string;
  readonly startedAt: number;
  /** Where this execution's window starts in the project watch; null without a watch. */
  readonly mark: ProjectWriteMark | null;
}

export interface ObservedComputeProjectImage {
  readonly relativePath: string;
  readonly mediaType: ComputeImageMediaType;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ComputeProjectOutputCollection {
  readonly images: ReadonlyArray<ObservedComputeProjectImage>;
  /** Tables written during the observation, to point at. They are not read. */
  readonly tables: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** Structured facts only; analytics must never classify the warning text. */
  readonly capture?: ComputeProjectCaptureStatus;
}

export interface ComputeProjectOutputLimits {
  readonly maximumBytes: number;
}

/** Outputs of one session or file run in one project folder, held for its scope. */
export interface ComputeProjectOutputWatch {
  /** Settles once the project watch is listening or has failed. */
  readonly ready: Effect.Effect<void>;
  /** Touches no files, so it can sit on the execution admission path. */
  readonly begin: Effect.Effect<ComputeProjectOutputObservation>;
  /** `writes` is what the runtime saw the execution write: extra candidates, checked, never trusted. */
  readonly collect: (
    observation: ComputeProjectOutputObservation,
    limits: ComputeProjectOutputLimits,
    writes?: ComputeRuntimeWriteReport,
  ) => Effect.Effect<ComputeProjectOutputCollection>;
}

export interface ComputeProjectOutputObserverPort {
  readonly watch: (
    projectRoot: string,
  ) => Effect.Effect<ComputeProjectOutputWatch, never, Scope.Scope>;
}

function imageMediaType(name: string): ComputeImageMediaType | null {
  switch (NodePath.extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

const TABLE_FILE = /\.(csv|tsv|parquet|xlsx)$/iu;

interface ProjectImageState {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

function sameState(left: ProjectImageState | undefined, right: ProjectImageState): boolean {
  return (
    left !== undefined &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  );
}

function isInsideProjectRoot(projectRoot: string, candidate: string): boolean {
  const relative = NodePath.relative(projectRoot, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

function imageState(metadata: NodeFS.BigIntStats): ProjectImageState {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAt: metadata.mtimeNs,
    changedAt: metadata.ctimeNs,
  };
}

const skippedDirectory = (name: string) => name.startsWith(".") || IGNORED_DIRECTORIES.has(name);

/**
 * Without a trustworthy watch, look for outputs changed since the run began, shallow folders
 * first. No baseline is needed: a file the run did not touch keeps its older times.
 */
async function scanRecentOutputs(
  projectRoot: string,
  since: bigint,
  signal: AbortSignal,
  now: () => number,
): Promise<{ readonly files: ReadonlyArray<string>; readonly limited: string | null }> {
  const deadline = now() + FALLBACK_SCAN_TIME_MS;
  const files: string[] = [];
  const queue = [projectRoot];
  let scanned = 0;
  let unreadable = false;
  for (let index = 0; index < queue.length; index += 1) {
    if (signal.aborted || now() >= deadline) return { files, limited: "time limit" };
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(queue[index]!, { withFileTypes: true });
    } catch {
      unreadable = true;
      continue;
    }
    scanned += entries.length;
    if (scanned > FALLBACK_SCAN_ENTRIES) return { files, limited: "entry limit" };
    const environment = entries.some((entry) =>
      (ENVIRONMENT_MARKERS as ReadonlyArray<string>).includes(entry.name),
    );
    for (const entry of entries) {
      const path = NodePath.join(queue[index]!, entry.name);
      if (entry.isDirectory()) {
        if (!environment && !skippedDirectory(entry.name)) queue.push(path);
      } else if (entry.isFile() && OUTPUT_FILE.test(entry.name)) {
        const metadata = await NodeFSP.lstat(path, { bigint: true }).catch(() => null);
        if (metadata !== null && changedSince(metadata, since)) files.push(path);
      }
    }
  }
  return { files, limited: unreadable ? "unreadable directory" : null };
}

const isGone = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Output files inside folders created during the window, which inotify may not have reported. */
async function filesInCreatedEntries(
  created: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<{
  readonly files: ReadonlyArray<string>;
  readonly limited: "scan-entry-limit" | "scan-unreadable" | null;
}> {
  const files: string[] = [];
  const queue: string[] = [];
  let unreadable = false;
  for (const path of created) {
    const metadata = await NodeFSP.lstat(path).catch((error: unknown) => {
      if (!isGone(error)) unreadable = true;
      return null;
    });
    if (metadata?.isDirectory()) queue.push(path);
  }
  let listed = 0;
  let index = 0;
  for (; index < queue.length && listed < CREATED_DIRECTORY_ENTRIES; index += 1) {
    signal.throwIfAborted();
    let entries: NodeFS.Dirent[];
    try {
      entries = await NodeFSP.readdir(queue[index]!, { withFileTypes: true });
    } catch (error) {
      // A folder removed again before the run ended held nothing to show.
      if (!isGone(error)) unreadable = true;
      continue;
    }
    listed += entries.length;
    for (const entry of entries) {
      const path = NodePath.join(queue[index]!, entry.name);
      if (entry.isDirectory() && !skippedDirectory(entry.name)) queue.push(path);
      else if (entry.isFile() && OUTPUT_FILE.test(entry.name)) files.push(path);
    }
  }
  return {
    files,
    limited: index < queue.length ? "scan-entry-limit" : unreadable ? "scan-unreadable" : null,
  };
}

/** Whole-second times come from a coarse file system; others are near the wall clock. */
function changedSince(metadata: NodeFS.BigIntStats, startedAt: bigint): boolean {
  const changed = (time: bigint) =>
    time >= startedAt - (time % 1_000_000_000n === 0n ? COARSE_TIME_SLACK_NS : FINE_TIME_SLACK_NS);
  return changed(metadata.mtimeNs) || changed(metadata.ctimeNs);
}

/** A reported path becomes a project output only if it is a fresh regular file in the project. */
async function authorizeCandidate(
  projectRoot: string,
  path: string,
  since: bigint,
): Promise<{ readonly relativePath: string; readonly state: ProjectImageState } | null> {
  if (!NodePath.isAbsolute(path) || !OUTPUT_FILE.test(path)) return null;
  const parent = await NodeFSP.realpath(NodePath.dirname(path)).catch(() => null);
  if (parent === null) return null;
  const canonical = NodePath.join(parent, NodePath.basename(path));
  if (!isInsideProjectRoot(projectRoot, canonical)) return null;
  const segments = NodePath.relative(projectRoot, canonical).split(NodePath.sep);
  if (segments.slice(0, -1).some(skippedDirectory)) return null;
  const metadata = await NodeFSP.lstat(canonical, { bigint: true }).catch(() => null);
  if (metadata === null || !metadata.isFile() || !changedSince(metadata, since)) return null;
  return { relativePath: segments.join("/"), state: imageState(metadata) };
}

const stateKey = (state: ProjectImageState) =>
  `${String(state.device)}:${String(state.inode)}:${String(state.size)}:${String(state.modifiedAt)}:${String(state.changedAt)}`;

async function readObservedImage(
  projectRoot: string,
  relativePath: string,
  observed: ProjectImageState,
  signal: AbortSignal,
): Promise<
  ObservedComputeProjectImage | { readonly warning: string; readonly reason: ComputeCaptureReason }
> {
  const rejected = (reason: ComputeCaptureReason, warning: string) => ({ reason, warning });
  if (relativePath.length > 4_096) {
    return rejected(
      "unsafe-image",
      "A generated figure path exceeded Scient's retained provenance limit.",
    );
  }
  const mediaType = imageMediaType(relativePath);
  if (mediaType === null)
    return rejected("invalid-image", `Generated file '${relativePath}' is not a supported figure.`);
  const absolutePath = NodePath.join(projectRoot, ...relativePath.split("/"));
  const noFollow = "O_NOFOLLOW" in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0;
  let file: NodeFSP.FileHandle | null = null;
  try {
    const pathMetadata = await NodeFSP.lstat(absolutePath, { bigint: true });
    if (!pathMetadata.isFile()) {
      return rejected("unsafe-image", `Generated figure '${relativePath}' is not a regular file.`);
    }
    file = await NodeFSP.open(absolutePath, NodeFS.constants.O_RDONLY | noFollow);
    const canonicalPath = await NodeFSP.realpath(absolutePath);
    if (!isInsideProjectRoot(projectRoot, canonicalPath)) {
      return rejected(
        "unsafe-image",
        `Generated figure '${relativePath}' resolved outside the project.`,
      );
    }
    const before = await file.stat({ bigint: true });
    const canonicalMetadata = await NodeFSP.lstat(canonicalPath, { bigint: true });
    if (
      !before.isFile() ||
      !sameState(observed, imageState(before)) ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.dev !== canonicalMetadata.dev ||
      before.ino !== canonicalMetadata.ino
    ) {
      return rejected(
        "image-changed",
        `Generated figure '${relativePath}' changed before it could be retained.`,
      );
    }
    if (before.size > BigInt(MAXIMUM_IMAGE_BYTES)) {
      return rejected(
        "image-limit",
        `Generated figure '${relativePath}' exceeded the ${String(MAXIMUM_IMAGE_BYTES)}-byte limit.`,
      );
    }
    // A writer can grow the file after stat. Never allocate/read beyond the cap.
    signal.throwIfAborted();
    const buffer = new Uint8Array(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const contents = buffer.subarray(0, offset);
    if (contents.byteLength > MAXIMUM_IMAGE_BYTES) {
      return rejected(
        "image-limit",
        `Generated figure '${relativePath}' exceeded the ${String(MAXIMUM_IMAGE_BYTES)}-byte limit.`,
      );
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(contents.byteLength) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return rejected(
        "image-changed",
        `Generated figure '${relativePath}' changed while it was being retained.`,
      );
    }
    const inspection = inspectComputeStaticImage(mediaType, contents);
    if (inspection === null) {
      return rejected(
        "invalid-image",
        `Generated figure '${relativePath}' is not a valid ${mediaType === "image/png" ? "PNG" : "SVG"}.`,
      );
    }
    const contentHash = `sha256:${NodeCrypto.createHash("sha256").update(contents).digest("hex")}`;
    return {
      relativePath,
      mediaType,
      contentHash,
      bytes: contents,
      width: inspection.width,
      height: inspection.height,
    };
  } catch {
    return rejected("unsafe-image", `Generated figure '${relativePath}' could not be read safely.`);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

const unavailableCollection = (
  coverageReason: ComputeCaptureReason,
  warning: string | null,
): ComputeProjectOutputCollection => ({
  images: [],
  tables: [],
  warnings: warning === null ? [] : [warning],
  capture: { coverage: "unavailable", coverageReason, rejectedCount: 0 },
});

async function collectProjectOutputs(input: {
  readonly projectRoot: string;
  readonly projectWatch: ProjectWriteWatch | null;
  readonly observation: ComputeProjectOutputObservation;
  readonly limits: ComputeProjectOutputLimits;
  readonly writes: ComputeRuntimeWriteReport | undefined;
  /** Outputs this holder already showed, so a late watch event cannot show one twice. */
  readonly shown: Map<string, string>;
  readonly signal: AbortSignal;
  readonly now: () => number;
}): Promise<ComputeProjectOutputCollection> {
  const { projectRoot, observation, writes, signal } = input;
  const since = BigInt(observation.startedAt) * 1_000_000n;
  // A runtime's own record adds what the watch may have lost; only the watch can vouch for coverage.
  const reported = new Set(writes?.paths ?? []);
  const warnings: string[] = [];
  let coverageReason: ComputeCaptureReason | undefined;
  const window =
    input.projectWatch === null || observation.mark === null
      ? ({ healthy: false, reason: "watch-unavailable" } as const)
      : await input.projectWatch.read(observation.mark, signal);
  if (window.healthy) {
    for (const path of window.files) reported.add(path);
    const recovered = await filesInCreatedEntries(window.created, signal);
    for (const path of recovered.files) reported.add(path);
    if (recovered.limited !== null)
      warnings.push(
        `Some project files could not be checked (${recovered.limited === "scan-entry-limit" ? "entry limit" : "unreadable directory"}).`,
      );
    coverageReason =
      recovered.limited ?? (window.lossDetectable ? undefined : "watch-unverifiable");
  } else {
    coverageReason = window.reason;
    const scan = await scanRecentOutputs(projectRoot, since, signal, input.now);
    for (const path of scan.files) reported.add(path);
    if (scan.limited !== null)
      warnings.push(`Some project files could not be checked (${scan.limited}).`);
  }
  const written = new Map<string, ProjectImageState>();
  for (const path of reported) {
    signal.throwIfAborted();
    const candidate = await authorizeCandidate(projectRoot, path, since);
    if (candidate === null) continue;
    if (input.shown.get(candidate.relativePath) === stateKey(candidate.state)) continue;
    written.set(candidate.relativePath, candidate.state);
  }
  const paths = [...written.keys()].toSorted();
  const tables = paths
    .filter((path) => TABLE_FILE.test(path))
    .slice(0, MAXIMUM_IMAGES_PER_EXECUTION);
  const changed = paths.filter((path) => !TABLE_FILE.test(path));
  const countLimited = changed.slice(0, MAXIMUM_IMAGES_PER_EXECUTION);
  const limited: string[] = [];
  let plannedBytes = 0n;
  const maximumBytes = BigInt(Math.max(0, Math.floor(input.limits.maximumBytes)));
  for (const path of countLimited) {
    const size = written.get(path)!.size;
    if (plannedBytes + size > maximumBytes) continue;
    limited.push(path);
    plannedBytes += size;
  }
  const results = [];
  for (const path of limited)
    results.push(await readObservedImage(projectRoot, path, written.get(path)!, signal));
  const images = results.filter(
    (result): result is ObservedComputeProjectImage => !("warning" in result),
  );
  const rejected = results.filter((result) => "warning" in result);
  for (const result of rejected) warnings.push(result.warning);
  const rejectionReason =
    rejected[0]?.reason ??
    (changed.length > countLimited.length
      ? "image-limit"
      : countLimited.length > limited.length
        ? "output-limit"
        : undefined);
  if (changed.length > countLimited.length)
    warnings.push(
      `Only the first ${String(MAXIMUM_IMAGES_PER_EXECUTION)} generated figures were retained.`,
    );
  if (countLimited.length > limited.length)
    warnings.push(
      "Some generated figures were not retained because the execution output limit was reached.",
    );
  for (const path of [...images.map((image) => image.relativePath), ...tables]) {
    input.shown.delete(path);
    input.shown.set(path, stateKey(written.get(path)!));
    if (input.shown.size > MAXIMUM_REMEMBERED_OUTPUTS)
      input.shown.delete(input.shown.keys().next().value!);
  }
  return {
    images,
    tables,
    capture: {
      coverage: coverageReason === undefined ? "complete" : "partial",
      ...(coverageReason === undefined ? {} : { coverageReason }),
      rejectedCount: rejected.length + changed.length - limited.length,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
    },
    warnings: [...new Set(warnings)],
  };
}

const disabledWatch = (projectRoot: string): ComputeProjectOutputWatch => ({
  ready: Effect.void,
  begin: Effect.succeed({ projectRoot, startedAt: 0, mark: null }),
  collect: () => Effect.succeed(unavailableCollection("observation-unavailable", null)),
});

const disabledObserver: ComputeProjectOutputObserverPort = {
  watch: (projectRoot) => Effect.succeed(disabledWatch(projectRoot)),
};

export class ComputeProjectOutputObserver extends Context.Service<
  ComputeProjectOutputObserver,
  ComputeProjectOutputObserverPort
>()("t3/scient/compute/ComputeProjectOutputObserver") {}

export function makeComputeProjectOutputObserver(
  watches: ProjectWriteWatches,
): ComputeProjectOutputObserverPort {
  return {
    watch: (projectRoot) =>
      Effect.acquireRelease(
        Effect.promise(async () => {
          const canonicalRoot = await NodeFSP.realpath(projectRoot).catch(() => null);
          return {
            projectRoot: canonicalRoot ?? projectRoot,
            projectWatch: canonicalRoot === null ? null : watches.acquire(canonicalRoot),
          };
        }),
        ({ projectWatch }) => Effect.promise(() => projectWatch?.close() ?? Promise.resolve()),
      ).pipe(
        Effect.map(({ projectRoot, projectWatch }): ComputeProjectOutputWatch => {
          const shown = new Map<string, string>();
          return {
            ready: Effect.promise(() => projectWatch?.ready() ?? Promise.resolve()),
            begin: Effect.clockWith((clock) =>
              Effect.sync(() => ({
                projectRoot,
                startedAt: clock.currentTimeMillisUnsafe(),
                mark: projectWatch?.mark() ?? null,
              })),
            ),
            collect: (observation, limits, writes) =>
              Effect.clockWith((clock) =>
                Effect.tryPromise({
                  try: (signal) =>
                    collectProjectOutputs({
                      projectRoot,
                      projectWatch,
                      observation,
                      limits,
                      writes,
                      shown,
                      signal,
                      now: () => clock.currentTimeMillisUnsafe(),
                    }),
                  catch: () => "failed" as const,
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: "3 seconds",
                    orElse: () =>
                      Effect.succeed(
                        unavailableCollection(
                          "scan-timeout",
                          "Some project files could not be checked (time limit).",
                        ),
                      ),
                  }),
                  Effect.orElseSucceed(() =>
                    unavailableCollection(
                      "observation-unavailable",
                      "Scient could not finish observing generated project figures.",
                    ),
                  ),
                ),
              ),
          };
        }),
      ),
  };
}

const loadNativeWatch = (): Promise<ProjectWatchBackend> => import("@parcel/watcher");

export const disabledLayer = Layer.succeed(ComputeProjectOutputObserver, disabledObserver);
export const liveLayer = Layer.effect(
  ComputeProjectOutputObserver,
  Effect.map(HostProcess.Platform, (platform) =>
    makeComputeProjectOutputObserver(
      makeProjectWriteWatches({ backend: loadNativeWatch, platform }),
    ),
  ),
);
