// @effect-diagnostics nodeBuiltinImport:off -- environment evidence is read from recorded project files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ComputeResultRevision,
  ResultHandoffChoices,
  ResultHandoffManifest,
} from "@t3tools/contracts";

import {
  hashBytes,
  isPortablePackagePath,
  packagePath,
  regularPackageFile,
} from "./handoffFiles.ts";

type Lockfile = NonNullable<ComputeResultRevision["environment"]>["lockfiles"][number];
type Status = NonNullable<ResultHandoffChoices["lockfiles"]>[number]["status"];

const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const text = new TextDecoder("utf-8", { fatal: true });

export const containsHomePath = (value: string) =>
  /[/\\]+(?:users|home)[/\\]+[^/\\\r\n"']+(?=[/\\\r\n"']|$)/iu.test(value);

async function lockfileCopy(project: string, lockfile: Lockfile) {
  const file =
    isPortablePackagePath(lockfile.path) && (await regularPackageFile(project, lockfile.path));
  if (!file || (await NodeFSP.stat(file)).size > MAX_LOCKFILE_BYTES) return null;
  const before = await NodeFSP.readFile(file);
  if (hashBytes(before) !== lockfile.sha256) return null;
  let contents: string;
  try {
    contents = text.decode(before);
  } catch {
    return null;
  }
  if (contents.includes("\0")) return null;
  const portable = /^environment\.ya?ml$/iu.test(NodePath.posix.basename(lockfile.path))
    ? contents.replace(/^prefix[ \t]*:[^\r\n]*(?:\r?\n|$)/gmu, "")
    : contents;
  if (containsHomePath(portable)) return { _tag: "private-path" } as const;
  return {
    _tag: "copy" as const,
    prefixRemoved: portable !== contents,
    bytes: portable === contents ? before : Buffer.from(portable, "utf8"),
  };
}

export async function handoffLockfileChoices(projectRoot: string, revision: ComputeResultRevision) {
  const project = await NodeFSP.realpath(projectRoot);
  return Promise.all(
    (revision.environment?.lockfiles ?? []).map(async (lockfile) => {
      const copy = await lockfileCopy(project, lockfile);
      const status: Status =
        copy === null
          ? "unavailable"
          : copy._tag === "private-path"
            ? "private-path"
            : copy.prefixRemoved
              ? "prefix-removed"
              : "ready";
      return {
        path: lockfile.path,
        status,
        ...(copy?._tag === "copy" ? { size: copy.bytes.length } : {}),
      };
    }),
  );
}

export async function exportHandoffLockfiles(
  project: string,
  pending: string,
  revision: ComputeResultRevision,
  exclusion: ReadonlyArray<string>,
) {
  const lockfiles: ResultHandoffManifest["environment"]["lockfiles"][number][] = [];
  const warnings: string[] = [];
  const excluded = new Set(exclusion);
  for (const lockfile of revision.environment?.lockfiles ?? []) {
    if (excluded.has(lockfile.path)) {
      lockfiles.push({ ...lockfile, included: false, excludedReason: "selected" });
      continue;
    }
    const copy = await lockfileCopy(project, lockfile);
    if (copy === null || copy._tag === "private-path") {
      const excludedReason = copy === null ? "unavailable" : "private-path";
      lockfiles.push({ ...lockfile, included: false, excludedReason });
      warnings.push(
        excludedReason === "private-path"
          ? `${lockfile.path} was excluded because it contains a home-folder path.`
          : `${lockfile.path} was excluded because the recorded copy was unavailable.`,
      );
      continue;
    }
    const target = packagePath(pending, `environment/lockfiles/${lockfile.path}`);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, copy.bytes, { flag: "wx" });
    lockfiles.push({
      ...lockfile,
      included: true,
      ...(copy.prefixRemoved ? { prefixRemoved: true, fileSha256: hashBytes(copy.bytes) } : {}),
    });
  }
  return { lockfiles, warnings };
}
