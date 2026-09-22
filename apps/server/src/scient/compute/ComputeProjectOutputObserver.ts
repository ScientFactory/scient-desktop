// @effect-diagnostics nodeBuiltinImport:off -- execution-scoped project outputs are host files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeImageMediaType } from "@scientfactory/compute";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { inspectComputeStaticImage } from "./ComputeStaticImage.ts";

const MAXIMUM_SCANNED_ENTRIES = 4_096;
const MAXIMUM_DIRECTORY_DEPTH = 8;
const MAXIMUM_IMAGES_PER_EXECUTION = 32;
const MAXIMUM_IMAGE_BYTES = 8 * 1024 * 1024;
// Return partial coverage before the service's one-second baseline admission timeout.
const OBSERVATION_TIMEOUT_MS = 750;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".scient",
  ".scient-next",
  ".t3",
  ".venv",
  "__pycache__",
  "node_modules",
]);

class ProjectOutputObservationFailure extends Data.TaggedError("ProjectOutputObservationFailure")<{
  readonly cause: unknown;
}> {}

interface ProjectImageState {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

interface ProjectImageSnapshot {
  readonly files: ReadonlyMap<string, ProjectImageState>;
  readonly directories: ReadonlyMap<string, ReadonlySet<string>>;
  readonly warnings: ReadonlyArray<string>;
}

export interface ComputeProjectOutputObservation {
  readonly projectRoot: string;
  readonly baseline: ProjectImageSnapshot | null;
  readonly warnings: ReadonlyArray<string>;
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
  readonly warnings: ReadonlyArray<string>;
}

export interface ComputeProjectOutputLimits {
  readonly maximumBytes: number;
}

export interface ComputeProjectOutputObserverPort {
  readonly begin: (projectRoot: string) => Effect.Effect<ComputeProjectOutputObservation>;
  readonly collect: (
    observation: ComputeProjectOutputObservation,
    limits: ComputeProjectOutputLimits,
  ) => Effect.Effect<ComputeProjectOutputCollection>;
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

/** Absence is evidence only inside an inventoried parent, including a new subtree. */
function wasAbsent(snapshot: ProjectImageSnapshot, path: string): boolean {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const names = snapshot.directories.get(parts.slice(0, index).join("/"));
    if (names === undefined) return false;
    if (!names.has(parts[index]!)) return true;
  }
  return false;
}

async function snapshotProjectImages(
  projectRoot: string,
  signal: AbortSignal,
  now: () => number,
): Promise<ProjectImageSnapshot> {
  const deadline = now() + OBSERVATION_TIMEOUT_MS;
  const files = new Map<string, ProjectImageState>();
  const inventories = new Map<string, ReadonlySet<string>>();
  const reasons = new Set<string>();
  const directories = [{ absolutePath: projectRoot, relativePath: "", depth: 0 }];
  let scannedEntries = 0;

  while (directories.length > 0) {
    if (signal.aborted || now() >= deadline) {
      reasons.add("time limit");
      break;
    }
    const directory = directories.pop();
    if (directory === undefined) break;
    const remaining = MAXIMUM_SCANNED_ENTRIES - scannedEntries;
    if (remaining <= 0) {
      reasons.add("entry limit");
      break;
    }
    const entries: NodeFS.Dirent[] = [];
    let directoryIncomplete = false;
    try {
      const handle = await NodeFSP.opendir(directory.absolutePath);
      for await (const entry of handle) {
        if (signal.aborted || now() >= deadline) {
          reasons.add("time limit");
          directoryIncomplete = true;
          break;
        }
        if (entries.length >= remaining) {
          reasons.add("entry limit");
          directoryIncomplete = true;
          break;
        }
        entries.push(entry);
      }
    } catch {
      reasons.add("unreadable directory");
      continue;
    }
    if (!directoryIncomplete)
      inventories.set(directory.relativePath, new Set(entries.map((entry) => entry.name)));
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (signal.aborted || now() >= deadline) {
        reasons.add("time limit");
        break;
      }
      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = NodePath.join(directory.absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (
          directory.depth >= MAXIMUM_DIRECTORY_DEPTH &&
          !entry.name.startsWith(".") &&
          !IGNORED_DIRECTORIES.has(entry.name)
        )
          reasons.add("depth limit");
        if (
          directory.depth < MAXIMUM_DIRECTORY_DEPTH &&
          !entry.name.startsWith(".") &&
          !IGNORED_DIRECTORIES.has(entry.name)
        ) {
          directories.push({
            absolutePath,
            relativePath,
            depth: directory.depth + 1,
          });
        }
        continue;
      }
      if (!entry.isFile() || imageMediaType(entry.name) === null) continue;
      try {
        const metadata = await NodeFSP.lstat(absolutePath, { bigint: true });
        if (!metadata.isFile()) continue;
        files.set(relativePath, imageState(metadata));
      } catch {
        reasons.add("unreadable file");
      }
    }
    if (directoryIncomplete) break;
  }
  return {
    files,
    directories: inventories,
    warnings:
      reasons.size === 0
        ? []
        : [`Some project files could not be checked (${[...reasons].join(", ")}).`],
  };
}

async function readObservedImage(
  projectRoot: string,
  relativePath: string,
  observed: ProjectImageState,
  signal: AbortSignal,
): Promise<ObservedComputeProjectImage | string> {
  if (relativePath.length > 4_096) {
    return "A generated figure path exceeded Scient's retained provenance limit.";
  }
  const mediaType = imageMediaType(relativePath);
  if (mediaType === null) return `Generated file '${relativePath}' is not a supported figure.`;
  const absolutePath = NodePath.join(projectRoot, ...relativePath.split("/"));
  const noFollow = "O_NOFOLLOW" in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0;
  let file: NodeFSP.FileHandle | null = null;
  try {
    const pathMetadata = await NodeFSP.lstat(absolutePath, { bigint: true });
    if (!pathMetadata.isFile()) {
      return `Generated figure '${relativePath}' is not a regular file.`;
    }
    file = await NodeFSP.open(absolutePath, NodeFS.constants.O_RDONLY | noFollow);
    const canonicalPath = await NodeFSP.realpath(absolutePath);
    if (!isInsideProjectRoot(projectRoot, canonicalPath)) {
      return `Generated figure '${relativePath}' resolved outside the project.`;
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
      return `Generated figure '${relativePath}' changed before it could be retained.`;
    }
    if (before.size > BigInt(MAXIMUM_IMAGE_BYTES)) {
      return `Generated figure '${relativePath}' exceeded the ${String(MAXIMUM_IMAGE_BYTES)}-byte limit.`;
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
      return `Generated figure '${relativePath}' exceeded the ${String(MAXIMUM_IMAGE_BYTES)}-byte limit.`;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(contents.byteLength) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return `Generated figure '${relativePath}' changed while it was being retained.`;
    }
    const inspection = inspectComputeStaticImage(mediaType, contents);
    if (inspection === null) {
      return `Generated figure '${relativePath}' is not a valid ${mediaType === "image/png" ? "PNG" : "SVG"}.`;
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
    return `Generated figure '${relativePath}' could not be read safely.`;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

const disabledObserver: ComputeProjectOutputObserverPort = {
  begin: (projectRoot) => Effect.succeed({ projectRoot, baseline: null, warnings: [] }),
  collect: () => Effect.succeed({ images: [], warnings: [] }),
};

export class ComputeProjectOutputObserver extends Context.Service<
  ComputeProjectOutputObserver,
  ComputeProjectOutputObserverPort
>()("t3/scient/compute/ComputeProjectOutputObserver") {}

const liveObserver: ComputeProjectOutputObserverPort = {
  begin: (projectRoot) =>
    Effect.clockWith((clock) =>
      Effect.tryPromise({
        try: async (signal) => {
          const canonicalProjectRoot = await NodeFSP.realpath(projectRoot);
          return {
            canonicalProjectRoot,
            baseline: await snapshotProjectImages(canonicalProjectRoot, signal, () =>
              clock.currentTimeMillisUnsafe(),
            ),
          };
        },
        catch: (cause) => new ProjectOutputObservationFailure({ cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(new ProjectOutputObservationFailure({ cause: "time limit" })),
        }),
        Effect.match({
          onFailure: () => ({
            projectRoot,
            baseline: null,
            warnings: [
              "Some project files could not be checked (initial observation unavailable).",
            ],
          }),
          onSuccess: ({ canonicalProjectRoot, baseline }) => ({
            projectRoot: canonicalProjectRoot,
            baseline,
            warnings: [],
          }),
        }),
      ),
    ),
  collect: (observation, limits) =>
    observation.baseline === null
      ? Effect.succeed({ images: [], warnings: observation.warnings })
      : Effect.clockWith((clock) =>
          Effect.tryPromise({
            try: (signal) =>
              snapshotProjectImages(observation.projectRoot, signal, () =>
                clock.currentTimeMillisUnsafe(),
              ),
            catch: (cause) => new ProjectOutputObservationFailure({ cause }),
          }).pipe(
            Effect.flatMap((after) => {
              const changed = [...after.files.entries()]
                .filter(([path, state]) => {
                  const baseline = observation.baseline!;
                  const before = baseline.files.get(path);
                  return before === undefined
                    ? wasAbsent(baseline, path)
                    : !sameState(before, state);
                })
                .map(([path]) => path)
                .toSorted();
              const countLimited = changed.slice(0, MAXIMUM_IMAGES_PER_EXECUTION);
              const limited: string[] = [];
              let plannedBytes = 0n;
              const maximumBytes = BigInt(Math.max(0, Math.floor(limits.maximumBytes)));
              for (const path of countLimited) {
                const size = after.files.get(path)?.size;
                if (size === undefined || plannedBytes + size > maximumBytes) continue;
                limited.push(path);
                plannedBytes += size;
              }
              return Effect.forEach(limited, (path) =>
                Effect.tryPromise({
                  try: (signal) =>
                    readObservedImage(
                      observation.projectRoot,
                      path,
                      after.files.get(path)!,
                      signal,
                    ),
                  catch: (cause) => new ProjectOutputObservationFailure({ cause }),
                }),
              ).pipe(
                Effect.map((results) => {
                  const images = results.filter(
                    (result): result is ObservedComputeProjectImage => typeof result !== "string",
                  );
                  const warnings = results.filter(
                    (result): result is string => typeof result === "string",
                  );
                  if (changed.length > countLimited.length) {
                    warnings.push(
                      `Only the first ${String(MAXIMUM_IMAGES_PER_EXECUTION)} generated figures were retained.`,
                    );
                  }
                  if (countLimited.length > limited.length) {
                    warnings.push(
                      "Some generated figures were not retained because the execution output limit was reached.",
                    );
                  }
                  return {
                    images,
                    warnings: [
                      ...new Set([
                        ...observation.warnings,
                        ...observation.baseline!.warnings,
                        ...after.warnings,
                        ...warnings,
                      ]),
                    ],
                  };
                }),
                Effect.orElseSucceed(() => ({
                  images: [],
                  warnings: [
                    ...observation.warnings,
                    "Scient could not safely retain generated project figures.",
                  ],
                })),
              );
            }),
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () =>
                Effect.succeed({
                  images: [],
                  warnings: ["Some project files could not be checked (time limit)."],
                }),
            }),
            Effect.orElseSucceed(() => ({
              images: [],
              warnings: [
                ...observation.warnings,
                "Scient could not finish observing generated project figures.",
              ],
            })),
          ),
        ),
};

export const disabledLayer = Layer.succeed(ComputeProjectOutputObserver, disabledObserver);
export const liveLayer = Layer.succeed(ComputeProjectOutputObserver, liveObserver);
