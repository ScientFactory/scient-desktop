// @effect-diagnostics nodeBuiltinImport:off
/**
 * The Files panel's plain file-system changes, as Finder or an agent makes them. Paths go
 * through `resolveEntryPath` and the entry policy; nothing is deleted for good, since a
 * replaced item goes to the Trash first.
 */
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  WorkspaceEntryChangeError,
  WorkspaceEntryChangeFailure,
  type WorkspaceEntryChangeInput,
  type WorkspaceEntryChangeOutcome,
  type WorkspaceEntryChangeResult,
  type WorkspaceEntryCollision,
  type WorkspaceEntryTransferItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { workspaceEntryDisposition } from "./WorkspaceEntryPolicy.ts";
import {
  moveToTrash,
  splitName,
  trashCanRestore,
  trashName,
  type TrashHost,
} from "./WorkspaceTrash.ts";

type ResolveEntryPath = WorkspaceFileSystem["Service"]["resolveEntryPath"];

interface Entry {
  readonly relativePath: string;
  readonly absolutePath: string;
}

/** A failure on the way, with whatever already changed. */
class ChangeFailure extends Schema.TaggedError<ChangeFailure>()("ChangeFailure", {
  failure: WorkspaceEntryChangeFailure,
  message: Schema.String,
  paths: Schema.optional(Schema.Array(Schema.String)),
}) {}

const isChangeFailure = Schema.is(ChangeFailure);

const toChangeError = (error: unknown, completed: ReadonlyArray<WorkspaceEntryChangeOutcome>) =>
  new WorkspaceEntryChangeError({
    failure: isChangeFailure(error) ? error.failure : "failed",
    message: (error instanceof Error && error.message.trim()) || "The change could not be made.",
    ...(isChangeFailure(error) && error.paths ? { paths: [...error.paths] } : {}),
    ...(completed.length > 0 ? { completed: [...completed] } : {}),
  });

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

async function lstatOrNull(path: string): Promise<NodeFS.Stats | null> {
  try {
    return await NodeFSP.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

const sameEntry = (left: NodeFS.Stats, right: NodeFS.Stats) =>
  left.dev === right.dev && left.ino === right.ino;

const isWithin = (parent: string, child: string) =>
  child === parent ||
  child.startsWith(parent.endsWith(NodePath.sep) ? parent : parent + NodePath.sep);

const parentOf = (relativePath: string) => {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
};
const joinRelative = (parent: string, leaf: string) => (parent ? `${parent}/${leaf}` : leaf);

/**
 * A free name next to `entry`, as Finder picks one: "name copy", "name copy 2"
 * for a copy in its own folder, otherwise "name 2", "name 3".
 */
async function freeEntry(
  entry: Entry,
  isDirectory: boolean,
  style: "copy" | "number",
): Promise<Entry> {
  const leaf = NodePath.basename(entry.absolutePath);
  const { name, extension } = splitName(leaf, isDirectory);
  const directory = NodePath.dirname(entry.absolutePath);
  for (let attempt = 1; attempt < 10_000; attempt++) {
    const candidate =
      style === "copy"
        ? `${name} copy${attempt === 1 ? "" : ` ${attempt}`}${extension}`
        : `${name} ${attempt + 1}${extension}`;
    const absolutePath = NodePath.join(directory, candidate);
    if ((await lstatOrNull(absolutePath)) === null) {
      return { absolutePath, relativePath: joinRelative(parentOf(entry.relativePath), candidate) };
    }
  }
  throw new ChangeFailure({ failure: "failed", message: `No free name was found for ${leaf}.` });
}

/** A rename, or a copy and removal between volumes. */
async function movePath(from: string, to: string): Promise<void> {
  try {
    await NodeFSP.rename(from, to);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await copyPath(from, to);
    await NodeFSP.rm(from, { recursive: true, force: true });
  }
}

const copyPath = (from: string, to: string) =>
  NodeFSP.cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

interface TrashedEntry {
  readonly cwd: string;
  readonly relativePath: string;
  readonly originalPath: string;
  readonly trashedPath: string;
  readonly infoPath?: string;
}

/** What this server moved to the Trash and can put back, newest last. */
const trashedEntries = new Map<string, TrashedEntry>();
const MAX_TRASHED_ENTRIES = 2_000;

function rememberTrashed(entry: TrashedEntry): string {
  const restoreId = NodeCrypto.randomUUID();
  trashedEntries.set(restoreId, entry);
  for (const oldest of trashedEntries.keys()) {
    if (trashedEntries.size <= MAX_TRASHED_ENTRIES) break;
    trashedEntries.delete(oldest);
  }
  return restoreId;
}

async function trashEntries(
  host: TrashHost,
  cwd: string,
  entries: ReadonlyArray<Entry>,
): Promise<WorkspaceEntryChangeOutcome[]> {
  const outcomes = await moveToTrash(
    host,
    entries.map((entry) => entry.absolutePath),
  );
  const completed: WorkspaceEntryChangeOutcome[] = [];
  const failed: { readonly entry: Entry; readonly message: string }[] = [];
  entries.forEach((entry, index) => {
    const outcome = outcomes[index];
    if (!outcome?.ok) {
      failed.push({ entry, message: outcome?.message ?? "Moving to the Trash failed." });
      return;
    }
    const restoreId =
      outcome.trashedPath === undefined
        ? undefined
        : rememberTrashed({
            cwd,
            relativePath: entry.relativePath,
            originalPath: entry.absolutePath,
            trashedPath: outcome.trashedPath,
            ...(outcome.infoPath ? { infoPath: outcome.infoPath } : {}),
          });
    completed.push({ from: entry.relativePath, ...(restoreId ? { restoreId } : {}) });
  });
  if (failed.length > 0) {
    const first = failed[0]!;
    throw Object.assign(
      new ChangeFailure({
        failure:
          completed.length === 0 && /no Trash/u.test(first.message)
            ? "trash-unavailable"
            : "failed",
        message: `${NodePath.basename(first.entry.absolutePath)} could not be moved to ${trashName(
          host.platform,
        )}: ${first.message}`,
        paths: failed.map(({ entry }) => entry.relativePath),
      }),
      { completed },
    );
  }
  return completed;
}

interface TransferPair {
  readonly from: Entry;
  readonly to: Entry;
}

async function transferEntries(input: {
  readonly host: TrashHost;
  readonly cwd: string;
  readonly mode: "move" | "copy";
  readonly pairs: ReadonlyArray<TransferPair>;
  readonly collision: WorkspaceEntryCollision;
  readonly completed: WorkspaceEntryChangeOutcome[];
}): Promise<void> {
  const { mode, collision, completed } = input;
  const sources = await Promise.all(input.pairs.map((pair) => lstatOrNull(pair.from.absolutePath)));
  const missing = input.pairs.filter((_, index) => sources[index] === null);
  if (missing.length > 0) {
    throw new ChangeFailure({
      failure: "missing",
      message: `${NodePath.basename(missing[0]!.from.absolutePath)} is no longer there.`,
      paths: missing.map((pair) => pair.from.relativePath),
    });
  }
  const pairs = input.pairs.map((pair, index) => ({ ...pair, source: sources[index]! }));
  // A move onto itself changes nothing; a case-only rename is still a move.
  const active = pairs.filter(
    (pair) => mode === "copy" || pair.from.absolutePath !== pair.to.absolutePath,
  );
  for (const pair of active) {
    // A copy onto its own name is a duplicate; anything else inside the folder is inside itself.
    if (
      pair.source.isDirectory() &&
      pair.from.absolutePath !== pair.to.absolutePath &&
      isWithin(pair.from.absolutePath, pair.to.absolutePath)
    ) {
      throw new ChangeFailure({
        failure: "into-itself",
        message: `${NodePath.basename(pair.from.absolutePath)} can't go inside itself.`,
        paths: [pair.from.relativePath],
      });
    }
  }
  const clashOf = async (pair: (typeof active)[number]) => {
    const existing = await lstatOrNull(pair.to.absolutePath);
    // On a case-insensitive disk "Notes.md" is "notes.md": renaming it is not a clash.
    return existing !== null && !(mode === "move" && sameEntry(existing, pair.source));
  };
  if (collision === "ask") {
    const clashes = (
      await Promise.all(active.map(async (pair) => ((await clashOf(pair)) ? pair : null)))
    ).filter((pair) => pair !== null);
    if (clashes.length > 0) {
      throw new ChangeFailure({
        failure: "exists",
        message: `An item named ${NodePath.basename(clashes[0]!.to.absolutePath)} already exists there.`,
        paths: clashes.map((pair) => pair.to.relativePath),
      });
    }
  }

  for (const pair of active) {
    let destination = pair.to;
    if (await clashOf(pair)) {
      if (collision === "ask") {
        throw new ChangeFailure({
          failure: "exists",
          message: `An item named ${NodePath.basename(destination.absolutePath)} already exists there.`,
          paths: [destination.relativePath],
        });
      }
      if (collision === "replace") {
        if (isWithin(destination.absolutePath, pair.from.absolutePath)) {
          throw new ChangeFailure({
            failure: "into-itself",
            message: `${NodePath.basename(destination.absolutePath)} can't be replaced by something inside it.`,
            paths: [destination.relativePath],
          });
        }
        completed.push(...(await trashEntries(input.host, input.cwd, [destination])));
      } else {
        const sameFolder =
          NodePath.dirname(pair.from.absolutePath) === NodePath.dirname(destination.absolutePath);
        destination = await freeEntry(
          destination,
          pair.source.isDirectory(),
          mode === "copy" && sameFolder ? "copy" : "number",
        );
      }
    }
    if (mode === "move") await movePath(pair.from.absolutePath, destination.absolutePath);
    else await copyPath(pair.from.absolutePath, destination.absolutePath);
    completed.push({ from: pair.from.relativePath, to: destination.relativePath });
  }
}

/** Paths inside another listed folder go with it. */
function outermost(entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> {
  return entries.filter(
    (entry, index) =>
      !entries.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.absolutePath !== entry.absolutePath &&
          isWithin(other.absolutePath, entry.absolutePath),
      ) && entries.findIndex((other) => other.absolutePath === entry.absolutePath) === index,
  );
}

export const changeWorkspaceEntries = Effect.fn("WorkspaceEntryChanges.change")(function* (
  resolveEntryPath: ResolveEntryPath,
  input: WorkspaceEntryChangeInput,
) {
  const host: TrashHost = {
    platform: yield* HostProcess.Platform,
    homeDirectory: yield* HostProcess.HomeDirectory,
    environment: yield* HostProcess.Environment,
    userId: yield* HostProcess.UserId,
  };
  const cwd = NodePath.resolve(input.cwd);
  const resolve = (relativePath: string) =>
    resolveEntryPath({ cwd: input.cwd, relativePath }).pipe(
      Effect.mapError((cause) => {
        const missing =
          cause._tag === "WorkspaceFileSystemOperationError" && errorCode(cause.cause) === "ENOENT";
        return new WorkspaceEntryChangeError({
          failure: missing ? "missing" : "not-allowed",
          ...(relativePath.trim() ? { paths: [relativePath] } : {}),
          message: missing
            ? `The folder for ${relativePath} is no longer there.`
            : `Files can't change ${relativePath.trim() || "the project folder"}.`,
        });
      }),
      // What Files only shows (Scient's own records, tool folders) stays as it is.
      Effect.filterOrFail(
        (entry) => workspaceEntryDisposition(entry.relativePath).mutation !== "owner",
        (entry) =>
          new WorkspaceEntryChangeError({
            failure: "not-allowed",
            paths: [entry.relativePath],
            message: `${entry.relativePath} is managed by Scient or another tool, so Files leaves it as it is.`,
          }),
      ),
    );
  const resolveAll = (relativePaths: ReadonlyArray<string>) =>
    Effect.forEach(relativePaths, resolve);
  const completed: WorkspaceEntryChangeOutcome[] = [];
  const run = (work: () => Promise<void>) =>
    Effect.tryPromise({
      try: async () => {
        await work();
        return { entries: completed } satisfies WorkspaceEntryChangeResult;
      },
      catch: (error) => {
        const partial = (error as { completed?: WorkspaceEntryChangeOutcome[] }).completed;
        return toChangeError(error, partial ? [...completed, ...partial] : completed);
      },
    });

  const change = input.change;
  switch (change._tag) {
    case "create-folder":
    case "create-file": {
      const isFolder = change._tag === "create-folder";
      const [requested] = yield* resolveAll([change.relativePath]);
      return yield* run(async () => {
        const entry = (await lstatOrNull(requested!.absolutePath))
          ? await freeEntry(requested!, isFolder, "number")
          : requested!;
        if (isFolder) await NodeFSP.mkdir(entry.absolutePath);
        else await NodeFSP.writeFile(entry.absolutePath, "", { flag: "wx" });
        completed.push({ to: entry.relativePath });
      });
    }
    case "move":
    case "copy": {
      const resolveItem = (item: WorkspaceEntryTransferItem) =>
        Effect.all({ from: resolve(item.from), to: resolve(item.to) });
      const pairs = yield* Effect.forEach(change.items, resolveItem);
      return yield* run(() =>
        transferEntries({
          host,
          cwd,
          mode: change._tag,
          pairs,
          collision: change.collision,
          completed,
        }),
      );
    }
    case "import": {
      // Sources are elsewhere on this computer, named by absolute path; only the
      // destinations are project paths, checked like any other change.
      const sources = change.sources.map((source) => NodePath.resolve(source));
      const outside = change.sources.find((source) => !NodePath.isAbsolute(source));
      if (outside !== undefined) {
        return yield* new WorkspaceEntryChangeError({
          failure: "not-allowed",
          paths: [outside],
          message: `${outside} is not a full path on this computer.`,
        });
      }
      const destinations = yield* Effect.forEach(sources, (source) =>
        resolve(joinRelative(change.folder, NodePath.basename(source))),
      );
      const pairs = sources.map((source, index) => ({
        from: { relativePath: source, absolutePath: source },
        to: destinations[index]!,
      }));
      return yield* run(() =>
        transferEntries({ host, cwd, mode: "copy", pairs, collision: change.collision, completed }),
      );
    }
    case "trash": {
      const entries = outermost(yield* resolveAll(change.relativePaths));
      return yield* run(async () => {
        const missing: Entry[] = [];
        for (const entry of entries) {
          if ((await lstatOrNull(entry.absolutePath)) === null) missing.push(entry);
        }
        if (missing.length > 0) {
          throw new ChangeFailure({
            failure: "missing",
            message: `${NodePath.basename(missing[0]!.absolutePath)} is no longer there.`,
            paths: missing.map((entry) => entry.relativePath),
          });
        }
        completed.push(...(await trashEntries(host, cwd, entries)));
      });
    }
    case "restore": {
      const records = change.restoreIds.map((restoreId) => ({
        restoreId,
        record: trashedEntries.get(restoreId),
      }));
      if (records.some(({ record }) => record === undefined || record.cwd !== cwd)) {
        return yield* new WorkspaceEntryChangeError({
          failure: "restore-unavailable",
          message: trashCanRestore(host.platform)
            ? "Scient no longer knows where these items went. They are still in the Trash."
            : "Scient can't put items back from the Recycle Bin. Restore them from the Recycle Bin.",
        });
      }
      // Each item goes back through the same checks as any other change.
      const targets = yield* Effect.forEach(records, ({ record }) => resolve(record!.relativePath));
      return yield* run(async () => {
        for (const [index, { restoreId, record }] of records.entries()) {
          const target = targets[index]!;
          const trashed = await lstatOrNull(record!.trashedPath);
          if (trashed === null) {
            throw new ChangeFailure({
              failure: "missing",
              message: `${NodePath.basename(record!.originalPath)} is no longer in the Trash.`,
              paths: [record!.relativePath],
            });
          }
          const destination = (await lstatOrNull(target.absolutePath))
            ? await freeEntry(target, trashed.isDirectory(), "number")
            : target;
          await NodeFSP.rename(record!.trashedPath, destination.absolutePath);
          if (record!.infoPath) await NodeFSP.rm(record!.infoPath, { force: true });
          trashedEntries.delete(restoreId);
          completed.push({ to: destination.relativePath, restoreId });
        }
      });
    }
  }
});
