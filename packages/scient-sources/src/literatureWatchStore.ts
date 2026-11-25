// @effect-diagnostics nodeBuiltinImport:off -- Literature watches are small files in the library.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  LiteratureWatch,
  LiteratureWatchRun,
  type LiteratureWatchDefinition,
} from "./literatureWatch.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceActor } from "./model.ts";
import { assertSafeIdentifier, atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const WATCHES_DIRECTORY = "watches";
const RUN_SUFFIX = ".run.json";
const MAX_WATCH_BYTES = 16 * 1024 * 1024;
const MAX_RUN_BYTES = 32 * 1024 * 1024;

// @effect-diagnostics-next-line extendsNativeError:off - The source stores are Promise-based; callers catch native errors.
export class LiteratureWatchNotFoundError extends Error {
  constructor() {
    super("That watch does not exist.");
  }
}

function watchesDirectory(library: ScientLibraryLocation) {
  return NodePath.join(library.root, WATCHES_DIRECTORY);
}

function watchPath(library: ScientLibraryLocation, watchId: string) {
  assertSafeIdentifier(watchId, "Watch ID");
  return NodePath.join(watchesDirectory(library), `${watchId}.json`);
}

function runPath(library: ScientLibraryLocation, watchId: string) {
  assertSafeIdentifier(watchId, "Watch ID");
  return NodePath.join(watchesDirectory(library), `${watchId}${RUN_SUFFIX}`);
}

export async function readLiteratureWatch(
  library: ScientLibraryLocation,
  watchId: string,
): Promise<LiteratureWatch> {
  const filePath = watchPath(library, watchId);
  if ((await snapshot(filePath)) !== "file") throw new LiteratureWatchNotFoundError();
  return readBoundedJson(filePath, MAX_WATCH_BYTES, LiteratureWatch);
}

/** Every watch, newest change first; a file that cannot be read is reported, not fatal. */
export async function listLiteratureWatches(library: ScientLibraryLocation): Promise<{
  readonly watches: ReadonlyArray<LiteratureWatch>;
  readonly issues: ReadonlyArray<string>;
}> {
  const directory = watchesDirectory(library);
  if ((await snapshot(directory)) !== "directory") return { watches: [], issues: [] };
  const watches: LiteratureWatch[] = [];
  const issues: string[] = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(RUN_SUFFIX)) {
      continue;
    }
    try {
      watches.push(
        await readBoundedJson(NodePath.join(directory, entry.name), MAX_WATCH_BYTES, LiteratureWatch),
      );
    } catch {
      issues.push(`${WATCHES_DIRECTORY}/${entry.name} could not be read.`);
    }
  }
  return {
    watches: watches.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    issues,
  };
}

export async function createLiteratureWatch(
  library: ScientLibraryLocation,
  definition: LiteratureWatchDefinition,
  actor: ScientSourceActor,
  now: Date,
): Promise<LiteratureWatch> {
  const at = now.toISOString();
  const watch: LiteratureWatch = {
    formatVersion: 1,
    watchId: `watch-${NodeCrypto.randomUUID()}`,
    ...definition,
    covered: {},
    seen: [],
    briefings: [],
    createdAt: at,
    createdBy: actor,
    updatedAt: at,
  };
  await withScientLibraryLock(library.root, () =>
    atomicWriteJson(watchPath(library, watch.watchId), watch, MAX_WATCH_BYTES),
  );
  return watch;
}

/** Reads, changes and writes one watch under the Library lock. */
export async function changeLiteratureWatch(
  library: ScientLibraryLocation,
  watchId: string,
  change: (watch: LiteratureWatch) => LiteratureWatch | Promise<LiteratureWatch>,
): Promise<LiteratureWatch> {
  return withScientLibraryLock(library.root, async () => {
    const next = await change(await readLiteratureWatch(library, watchId));
    await atomicWriteJson(watchPath(library, watchId), next, MAX_WATCH_BYTES);
    return next;
  });
}

export async function deleteLiteratureWatch(
  library: ScientLibraryLocation,
  watchId: string,
): Promise<LiteratureWatch> {
  return withScientLibraryLock(library.root, async () => {
    const watch = await readLiteratureWatch(library, watchId);
    await NodeFSP.rm(runPath(library, watchId), { force: true });
    await NodeFSP.rm(watchPath(library, watchId));
    return watch;
  });
}

export async function writeLiteratureWatchRun(
  library: ScientLibraryLocation,
  run: LiteratureWatchRun,
): Promise<void> {
  await withScientLibraryLock(library.root, async () => {
    await readLiteratureWatch(library, run.watchId);
    await atomicWriteJson(runPath(library, run.watchId), run, MAX_RUN_BYTES);
  });
}

/** The watch's open run, or null when none was started or the last one was published. */
export async function readLiteratureWatchRun(
  library: ScientLibraryLocation,
  watchId: string,
): Promise<LiteratureWatchRun | null> {
  const filePath = runPath(library, watchId);
  if ((await snapshot(filePath)) !== "file") return null;
  return readBoundedJson(filePath, MAX_RUN_BYTES, LiteratureWatchRun);
}

/** Publishes the open run with `publish` and removes it, in one hold of the lock. */
export async function finishLiteratureWatchRun(
  library: ScientLibraryLocation,
  watchId: string,
  runId: string,
  publish: (watch: LiteratureWatch, run: LiteratureWatchRun) => LiteratureWatch,
): Promise<LiteratureWatch> {
  return withScientLibraryLock(library.root, async () => {
    const run = await readLiteratureWatchRun(library, watchId);
    const watch = await readLiteratureWatch(library, watchId);
    if (!run || run.runId !== runId) {
      // A retried publish finds its own briefing already saved.
      if (watch.briefings.some((briefing) => briefing.briefingId === runId)) return watch;
      throw new Error("That run is no longer open; start a new run.");
    }
    const next = publish(watch, run);
    await atomicWriteJson(watchPath(library, watchId), next, MAX_WATCH_BYTES);
    await NodeFSP.rm(runPath(library, watchId), { force: true });
    return next;
  });
}
