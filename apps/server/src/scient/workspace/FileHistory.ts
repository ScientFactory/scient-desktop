// @effect-diagnostics nodeBuiltinImport:off
/**
 * Earlier versions of the files Scient overwrites, kept outside the project. This is what
 * makes a save safe to simply happen: nothing it replaces is gone. Keeping a copy never
 * decides whether a save goes ahead.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Scient's own autosaves are kept this far apart. A change from elsewhere is always kept. */
const KEEP_OWN_SAVES_EVERY_MS = 5 * 60 * 1000;
const VERSIONS_PER_FILE = 30;
const TOTAL_BYTES = 1024 ** 3;

const VERSION_NAME = /^(\d+)-([a-f0-9]{64})(\.[a-zA-Z0-9]{1,16})$/u;
const VERSION_ID = /^history:(\d+-[a-f0-9]{64}\.[a-zA-Z0-9]{1,16})$/u;
const FILE_FOLDER = /^[a-f0-9]{64}$/u;

export const isFileHistoryVersion = (versionId: string) => VERSION_ID.test(versionId);

const folderFor = (directory: string, target: string) =>
  NodePath.join(directory, NodeCrypto.createHash("sha256").update(target).digest("hex"));

const missing = (cause: NodeJS.ErrnoException) => cause.code === "ENOENT";

const versionsIn = async (folder: string) => {
  const names = await NodeFSP.readdir(folder).catch((cause: NodeJS.ErrnoException) => {
    if (missing(cause)) return [];
    throw cause;
  });
  return names
    .flatMap((name) => {
      const match = VERSION_NAME.exec(name);
      return match
        ? [
            {
              name,
              at: Number(match[1]),
              revision: `sha256:${match[2]}`,
              path: NodePath.join(folder, name),
            },
          ]
        : [];
    })
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
};

/** A version another save removed while this one looked is simply gone. */
const sizeOf = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.size,
    (cause: NodeJS.ErrnoException) => {
      if (missing(cause)) return null;
      throw cause;
    },
  );

const revisionOf = async (path: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
};

/** Oldest first across every file, until the whole history fits; `kept` always stays. */
const limitTotal = async (directory: string, limit: number, kept: string) => {
  const all = [];
  for (const folder of await NodeFSP.readdir(directory)) {
    if (!FILE_FOLDER.test(folder)) continue;
    for (const version of await versionsIn(NodePath.join(directory, folder))) {
      const size = await sizeOf(version.path);
      if (size !== null) all.push({ ...version, size });
    }
  }
  let total = all.reduce((sum, version) => sum + version.size, 0);
  for (const version of all.sort((a, b) => a.at - b.at)) {
    if (total <= limit) return;
    if (version.path === kept) continue;
    await NodeFSP.rm(version.path, { force: true });
    total -= version.size;
  }
};

/**
 * Copies `target` into its history and says whether its current bytes are now safe there.
 * Each copy is named for the bytes it holds, whatever the file became since it was checked.
 */
export async function keepFileVersion(input: {
  readonly directory: string;
  readonly target: string;
  /** The revision on disk, about to be replaced. */
  readonly revision: string;
  /** Whether Scient wrote that revision itself. */
  readonly ownSave: boolean;
  readonly now: number;
  readonly totalBytes?: number;
}): Promise<boolean> {
  const limit = input.totalBytes ?? TOTAL_BYTES;
  const folder = folderFor(input.directory, input.target);
  await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
  const versions = await versionsIn(folder);
  const newest = versions[0];
  if (newest?.revision === input.revision) return true;
  if (input.ownSave && newest && input.now - newest.at < KEEP_OWN_SAVES_EVERY_MS) return false;
  // A file that could never fit must not cost every other file its history.
  if ((await NodeFSP.stat(input.target)).size > limit) return false;
  const partial = NodePath.join(folder, `.${input.now}.${NodeCrypto.randomUUID()}.partial`);
  try {
    await NodeFSP.copyFile(input.target, partial);
    const revision = await revisionOf(partial);
    if (revision === newest?.revision) return true;
    const extension = NodePath.extname(input.target);
    const name = `${input.now}-${revision.replace("sha256:", "")}${
      /^\.[a-zA-Z0-9]{1,16}$/u.test(extension) ? extension : ".txt"
    }`;
    const kept = NodePath.join(folder, name);
    await NodeFSP.rename(partial, kept);
    for (const old of versions.slice(VERSIONS_PER_FILE - 1))
      await NodeFSP.rm(old.path, { force: true });
    await limitTotal(input.directory, limit, kept);
    return revision === input.revision;
  } finally {
    await NodeFSP.rm(partial, { force: true }).catch(() => undefined);
  }
}

export async function listFileVersions(directory: string, target: string) {
  const versions = await versionsIn(folderFor(directory, target));
  const listed = await Promise.all(
    versions.map(async (version) => {
      const byteLength = await sizeOf(version.path);
      return byteLength === null
        ? []
        : [
            {
              versionId: `history:${version.name}`,
              mutationId: `history:${version.name}`,
              retainedPath: version.path,
              revision: version.revision,
              byteLength,
              retainedAt: version.at,
            },
          ];
    }),
  );
  return listed.flat();
}

export async function discardFileVersion(directory: string, target: string, versionId: string) {
  const name = VERSION_ID.exec(versionId)?.[1];
  if (name) await NodeFSP.rm(NodePath.join(folderFor(directory, target), name), { force: true });
}
