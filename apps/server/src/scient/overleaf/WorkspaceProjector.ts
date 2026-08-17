// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ScientOverleafOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { manifestMap, type TreeManifest } from "./model.ts";

interface JournalEntry {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly desiredHash: string | null;
  readonly backupPath: string | null;
  readonly applied: boolean;
}

async function hashExisting(filePath: string): Promise<string | null> {
  let info;
  try {
    info = await NodeFSP.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return "unsupported";
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const hash = NodeCrypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function appendJournal(handle: NodeFSP.FileHandle, entry: JournalEntry) {
  await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
  await handle.sync();
}

async function removeEmptyParents(root: string, start: string) {
  let current = NodePath.dirname(start);
  while (current !== root && current.startsWith(`${root}${NodePath.sep}`)) {
    try {
      await NodeFSP.rmdir(current);
    } catch {
      return;
    }
    current = NodePath.dirname(current);
  }
}

function projectedPath(root: string, relative: string): string {
  const target = NodePath.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${NodePath.resolve(root)}${NodePath.sep}`)) {
    throw projectionError(
      "filesystem_failed",
      "The projection journal contains an unsafe path.",
      false,
    );
  }
  return target;
}

function pathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = NodePath.resolve(root);
  const resolvedCandidate = NodePath.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${NodePath.sep}`)
  );
}

async function recoverJournal(operationDirectory: string, targetRoot: string): Promise<void> {
  const journalPath = NodePath.join(operationDirectory, "projection.journal.ndjson");
  let contents: string;
  try {
    contents = await NodeFSP.readFile(journalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const latest = new Map<string, JournalEntry>();
  for (const line of contents.split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as Partial<JournalEntry>;
    if (
      typeof parsed.path !== "string" ||
      parsed.schemaVersion !== 1 ||
      !(typeof parsed.desiredHash === "string" || parsed.desiredHash === null) ||
      !(typeof parsed.backupPath === "string" || parsed.backupPath === null) ||
      typeof parsed.applied !== "boolean"
    )
      throw projectionError("filesystem_failed", "The projection journal is corrupt.", false);
    latest.set(parsed.path, parsed as JournalEntry);
  }
  for (const entry of [...latest.values()].toReversed()) {
    const target = projectedPath(targetRoot, entry.path);
    const temporary = `${target}.scient-overleaf-${NodePath.basename(operationDirectory)}.tmp`;
    await NodeFSP.rm(temporary, { force: true });
    const current = await hashExisting(target).catch(() => "unreadable");
    if (current !== entry.desiredHash) continue;
    if (entry.backupPath === null) {
      await NodeFSP.rm(target, { force: true });
    } else {
      const operationBackup = NodePath.join(operationDirectory, "projection-backup");
      const connectionBackup = NodePath.join(
        NodePath.dirname(NodePath.dirname(operationDirectory)),
        "preconnect-backup",
      );
      if (
        !pathWithin(operationBackup, entry.backupPath) &&
        !pathWithin(connectionBackup, entry.backupPath)
      ) {
        throw projectionError(
          "filesystem_failed",
          "A projection journal references an unsafe backup path.",
          false,
        );
      }
      const backup = await NodeFSP.lstat(entry.backupPath).catch(() => null);
      if (backup?.isFile() !== true || backup.isSymbolicLink()) {
        throw projectionError(
          "filesystem_failed",
          "A projection backup is missing or unsafe.",
          false,
        );
      }
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.copyFile(entry.backupPath, target);
    }
  }
  await NodeFSP.rm(journalPath, { force: true });
}

function projectionError(
  code: "workspace_changed" | "filesystem_failed",
  message: string,
  retryable = true,
) {
  return new ScientOverleafOperationError({ code, message, retryable });
}
const isOverleafOperationError = Schema.is(ScientOverleafOperationError);

export class WorkspaceProjector extends Context.Service<
  WorkspaceProjector,
  {
    readonly verify: (input: {
      readonly targetRoot: string;
      readonly expected: TreeManifest;
    }) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly project: (input: {
      readonly sourceRoot: string;
      readonly targetRoot: string;
      readonly desired: TreeManifest;
      readonly expected: TreeManifest;
      readonly previousManaged: TreeManifest;
      readonly operationDirectory: string;
      readonly backupDirectory?: string;
    }) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly recover: (input: {
      readonly operationDirectory: string;
      readonly targetRoot: string;
    }) => Effect.Effect<void, ScientOverleafOperationError>;
  }
>()("t3/scient/overleaf/WorkspaceProjector") {}

export const make = Effect.fn("WorkspaceProjector.make")(() =>
  Effect.sync(() => {
    const recover: WorkspaceProjector["Service"]["recover"] = (input) =>
      Effect.tryPromise({
        try: () => recoverJournal(input.operationDirectory, input.targetRoot),
        catch: (cause) =>
          isOverleafOperationError(cause)
            ? cause
            : projectionError(
                "filesystem_failed",
                "Unable to recover an interrupted local projection.",
              ),
      });

    const verify: WorkspaceProjector["Service"]["verify"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          for (const file of input.expected.files) {
            const current = await hashExisting(
              NodePath.join(input.targetRoot, ...file.path.split("/")),
            );
            if (current !== file.hash)
              throw projectionError(
                "workspace_changed",
                "The project changed after Sync began. No workspace files were overwritten.",
              );
          }
        },
        catch: (cause) =>
          isOverleafOperationError(cause)
            ? cause
            : projectionError(
                "filesystem_failed",
                "Unable to verify the project before projection.",
              ),
      });

    const project: WorkspaceProjector["Service"]["project"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const desired = manifestMap(input.desired);
          const expected = manifestMap(input.expected);
          const previous = manifestMap(input.previousManaged);
          const paths = [...new Set([...desired.keys(), ...previous.keys()])].sort();
          await recoverJournal(input.operationDirectory, input.targetRoot);
          const backupRoot =
            input.backupDirectory ?? NodePath.join(input.operationDirectory, "projection-backup");
          const journalPath = NodePath.join(input.operationDirectory, "projection.journal.ndjson");
          if (input.backupDirectory === undefined)
            await NodeFSP.rm(backupRoot, { recursive: true, force: true });
          await NodeFSP.mkdir(backupRoot, { recursive: true });
          const journal = await NodeFSP.open(journalPath, "a");
          const applied: JournalEntry[] = [];
          try {
            for (const relative of paths) {
              const target = NodePath.join(input.targetRoot, ...relative.split("/"));
              const source = NodePath.join(input.sourceRoot, ...relative.split("/"));
              const desiredFile = desired.get(relative) ?? null;
              const expectedFile = expected.get(relative) ?? null;
              const currentHash = await hashExisting(target);
              const expectedHash = expectedFile?.hash ?? null;
              if (currentHash !== expectedHash) {
                throw projectionError(
                  "workspace_changed",
                  "The project changed after Sync began. No conflicting workspace file was overwritten.",
                );
              }
              if (desiredFile?.hash === currentHash) continue;
              const backup =
                currentHash === null ? null : NodePath.join(backupRoot, ...relative.split("/"));
              const pending: JournalEntry = {
                schemaVersion: 1,
                path: relative,
                desiredHash: desiredFile?.hash ?? null,
                backupPath: backup,
                applied: false,
              };
              await appendJournal(journal, pending);
              if (backup !== null) {
                await NodeFSP.mkdir(NodePath.dirname(backup), { recursive: true });
                await NodeFSP.copyFile(target, backup);
              }
              if (desiredFile === null) {
                await NodeFSP.rm(target, { force: true });
                await removeEmptyParents(input.targetRoot, target);
              } else {
                await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
                const temp = `${target}.scient-overleaf-${NodePath.basename(input.operationDirectory)}.tmp`;
                await NodeFSP.rm(temp, { force: true });
                try {
                  await NodeFSP.copyFile(source, temp);
                  const tempHandle = await NodeFSP.open(temp, "r+");
                  try {
                    await tempHandle.sync();
                  } finally {
                    await tempHandle.close();
                  }
                  await NodeFSP.rename(temp, target);
                } finally {
                  await NodeFSP.rm(temp, { force: true });
                }
                const written = await hashExisting(target);
                if (written !== desiredFile.hash)
                  throw projectionError(
                    "filesystem_failed",
                    "A projected Overleaf file failed verification.",
                  );
              }
              const complete = { ...pending, applied: true };
              applied.push(complete);
              await appendJournal(journal, complete);
            }
          } catch (cause) {
            for (const entry of applied.toReversed()) {
              const target = NodePath.join(input.targetRoot, ...entry.path.split("/"));
              const current = await hashExisting(target).catch(() => "unreadable");
              if (current !== entry.desiredHash) continue;
              if (entry.backupPath === null) {
                await NodeFSP.rm(target, { force: true }).catch(() => undefined);
              } else {
                await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
                await NodeFSP.copyFile(entry.backupPath, target);
              }
            }
            throw cause;
          } finally {
            await journal.close();
          }
          await NodeFSP.rm(journalPath, { force: true });
          if (input.backupDirectory === undefined) {
            await NodeFSP.rm(backupRoot, { recursive: true, force: true });
          }
        },
        catch: (cause) =>
          isOverleafOperationError(cause)
            ? cause
            : projectionError(
                "filesystem_failed",
                "Unable to project the Overleaf result into the workspace.",
              ),
      });

    return WorkspaceProjector.of({ verify, project, recover });
  }),
);

export const layer = Layer.effect(WorkspaceProjector, make());
