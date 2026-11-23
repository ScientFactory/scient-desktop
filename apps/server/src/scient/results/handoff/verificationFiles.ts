// @effect-diagnostics nodeBuiltinImport:off -- verify file digests and work on scratch copies.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ResultHandoffManifest,
  type ResultHandoffFinding,
  type ResultHandoffVerifyInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  copyPackageFile,
  handoffRefusal,
  includedDataPath,
  isPortablePackagePath,
  relativeInputPath,
  hashBytes,
  MAXIMUM_PACKAGE_LIST_BYTES,
  MAXIMUM_SOURCE_BYTES,
  matchesFile,
  packagePath,
  regularPackageFile,
  relativePackagePath,
} from "./handoffFiles.ts";
import { notebookCode, notebookPackageDigest } from "./notebookSource.ts";

const decodeManifest = Schema.decodeUnknownSync(ResultHandoffManifest);
const ignoredMetadataFiles = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export async function readPackageManifest(folder: string) {
  const file = await regularPackageFile(folder, "manifest.json");
  if (file === null || (await NodeFSP.stat(file)).size > MAX_MANIFEST_BYTES) {
    throw handoffRefusal("The package manifest is missing or too large.");
  }
  const manifest = decodeManifest(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  if (manifest.source.size > MAXIMUM_SOURCE_BYTES) {
    throw handoffRefusal("The package source is too large to verify.");
  }
  const validateNames = (paths: ReadonlyArray<string>) => {
    const seen = new Set<string>();
    for (const path of paths) {
      const key = relativeInputPath(path).normalize("NFC").toLowerCase();
      if (seen.has(key)) throw handoffRefusal("The package lists conflicting file names.");
      seen.add(key);
    }
  };
  relativePackagePath(manifest.source.path);
  validateNames([
    manifest.source.path,
    ...(manifest.code ?? []).map((file) => relativePackagePath(file.path)),
    ...manifest.inputs.map((input) => input.path),
    ...manifest.environment.lockfiles.filter((file) => file.included).map((file) => file.path),
  ]);
  validateNames(manifest.outputs.map((output) => relativePackagePath(output.name)));
  for (const lockfile of manifest.environment.lockfiles) {
    relativeInputPath(lockfile.path);
    if (lockfile.included) relativePackagePath(lockfile.path);
  }
  validateNames(
    manifest.inputs
      .filter((file) => file.included)
      .map((file) => includedDataPath(file.path, manifest.version)),
  );
  for (const input of manifest.inputs) {
    if (input.via !== undefined) relativeInputPath(input.via);
    if (input.included) relativePackagePath(input.path);
    if (
      input.included &&
      (input.sha256 === null || (input.changedDuringRun && !input.hashAtExport))
    ) {
      throw handoffRefusal("An included input has no recorded digest from the original run.");
    }
  }
  return manifest;
}

export interface VerifiedPackageFiles {
  readonly workspace: string;
  readonly reference: string;
  readonly results: string;
  readonly files: ReadonlyArray<ResultHandoffFinding>;
  readonly packages: ReadonlyArray<{ name: string; version: string }> | undefined;
}

export async function stageVerificationFiles(
  folder: string,
  scratch: string,
  manifest: ResultHandoffManifest,
  input: ResultHandoffVerifyInput,
  signal: AbortSignal,
): Promise<VerifiedPackageFiles> {
  signal.throwIfAborted();
  const suppliedFolder =
    input.inputsFolder === undefined
      ? null
      : await NodeFSP.realpath(input.inputsFolder).catch(() => null);
  const workspace = NodePath.join(scratch, "work");
  const reference = NodePath.join(scratch, "reference");
  const results = NodePath.join(scratch, "results");
  for (const directory of [workspace, reference, results]) await NodeFSP.mkdir(directory);

  const files: ResultHandoffFinding[] = [];
  const check = async (file: {
    readonly root: string | null;
    readonly path: string;
    readonly label?: string;
    readonly sha256: string;
    readonly size?: number;
    readonly maximumBytes?: number;
    readonly copyTo?: { readonly root: string; readonly path: string; readonly kind?: "input" };
    readonly kind?: "input";
    readonly matchedMessage?: string;
  }) => {
    signal.throwIfAborted();
    const path = file.label ?? file.path;
    const original =
      file.root === null ? null : await regularPackageFile(file.root, file.path, file.kind);
    const supplied = file.kind === "input" ? { separatelySupplied: true as const } : {};
    if (original === null) {
      files.push({
        path,
        status: "missing",
        message: "A regular file is required at this path.",
        ...supplied,
      });
      return;
    }
    if (
      file.maximumBytes !== undefined &&
      (await NodeFSP.stat(original)).size > file.maximumBytes
    ) {
      files.push({ path, status: "unchecked", message: "This file is too large to check." });
      return;
    }
    const matched =
      file.copyTo === undefined
        ? await matchesFile(original, file.sha256, file.size, signal)
        : await copyPackageFile(
            original,
            file.copyTo.root,
            file.copyTo.path,
            file.sha256,
            file.size,
            file.copyTo.kind,
            signal,
          );
    files.push(
      matched
        ? {
            path,
            status: "matched",
            ...(file.matchedMessage === undefined ? {} : { message: file.matchedMessage }),
          }
        : {
            path,
            status: "differs",
            message: "The file's bytes differ from the recorded digest.",
            ...supplied,
          },
    );
  };

  const source = { root: workspace, path: manifest.source.path };
  const path = `source/${source.path}`;
  await check({
    root: folder,
    path,
    sha256: manifest.source.fileSha256,
    size: manifest.source.size,
    copyTo: source,
  });
  if (files.at(-1)?.status === "matched") {
    const contents = await NodeFSP.readFile(packagePath(workspace, source.path), { signal });
    const hash =
      manifest.source.kind === "script"
        ? hashBytes(contents)
        : notebookPackageDigest(
            notebookCode(contents.toString("utf8")),
            manifest.source.notebookDigestVersion,
          );
    if (hash !== manifest.source.sha256) {
      files.push({
        path,
        status: "differs",
        message: "The source does not match the run's code digest.",
      });
    }
  }
  for (const file of manifest.code ?? []) {
    await check({
      root: folder,
      path: `source/${file.path}`,
      sha256: file.sha256,
      size: file.size,
      copyTo: { root: workspace, path: file.path },
    });
  }
  for (const recorded of manifest.inputs) {
    if (NodePath.sep === "\\" && !isPortablePackagePath(recorded.path)) {
      files.push({
        path: recorded.path,
        status: "unchecked",
        message: "This input name cannot be used on the Compute computer.",
      });
      continue;
    }
    if (recorded.sha256 === null || (recorded.changedDuringRun && !recorded.hashAtExport)) {
      files.push({
        path: recorded.path,
        status: "unchecked",
        message: "The original run did not record a stable digest for this input.",
      });
      continue;
    }
    await check({
      root: recorded.included ? folder : suppliedFolder,
      path: recorded.included ? includedDataPath(recorded.path, manifest.version) : recorded.path,
      label: recorded.path,
      sha256: recorded.sha256,
      size: recorded.size,
      copyTo: { root: workspace, path: recorded.path, kind: "input" },
      ...(recorded.included ? {} : { kind: "input" }),
      ...(recorded.changedSinceRun
        ? {
            matchedMessage:
              "This input changed since the original run. Its export-time copy matched.",
          }
        : recorded.hashAtExport
          ? { matchedMessage: "This input matched the digest computed at export." }
          : {}),
    });
  }
  for (const output of manifest.outputs) {
    if (!output.pruned) {
      await check({
        root: folder,
        path: `outputs/${output.name}`,
        sha256: output.sha256,
        size: output.size,
        copyTo: { root: reference, path: output.name },
      });
    }
  }
  for (const lockfile of manifest.environment.lockfiles) {
    if (lockfile.included) {
      await check({
        root: folder,
        path: `environment/lockfiles/${lockfile.path}`,
        sha256: lockfile.fileSha256 ?? lockfile.sha256,
        copyTo: { root: workspace, path: lockfile.path },
      });
    }
  }
  let packages: VerifiedPackageFiles["packages"];
  if (manifest.environment.packageListSha256 !== undefined) {
    await check({
      root: folder,
      path: "environment/packages.json",
      maximumBytes: MAXIMUM_PACKAGE_LIST_BYTES,
      sha256: manifest.environment.packageListSha256,
      copyTo: { root: scratch, path: "packages.json" },
    });
    if (files.at(-1)?.status === "matched") {
      const recorded = await NodeFSP.readFile(NodePath.join(scratch, "packages.json"), {
        encoding: "utf8",
        signal,
      });
      packages = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            name: Schema.String.check(Schema.isMaxLength(120)),
            version: Schema.String.check(Schema.isMaxLength(120)),
          }),
        ).check(Schema.isMaxLength(4000)),
      )(JSON.parse(recorded));
    }
  }
  if (manifest.license !== undefined)
    await check({ root: folder, path: "LICENSE", ...manifest.license });
  await check({ root: folder, path: "README.md", sha256: manifest.documentation.readmeSha256 });
  await check({
    root: folder,
    path: "ro-crate-metadata.json",
    sha256: manifest.documentation.crateSha256,
  });
  const expected = new Set([
    "manifest.json",
    "README.md",
    ...(manifest.license === undefined ? [] : ["LICENSE"]),
    "ro-crate-metadata.json",
    path,
    ...(manifest.code ?? []).map((file) => `source/${file.path}`),
    ...manifest.inputs
      .filter((file) => file.included)
      .map((file) => includedDataPath(file.path, manifest.version)),
    ...manifest.outputs.filter((file) => !file.pruned).map((file) => `outputs/${file.name}`),
    ...manifest.environment.lockfiles
      .filter((file) => file.included)
      .map((file) => `environment/lockfiles/${file.path}`),
    ...(manifest.environment.packageListSha256 === undefined ? [] : ["environment/packages.json"]),
  ]);
  signal.throwIfAborted();
  const entries = await NodeFSP.opendir(folder, { recursive: true });
  for await (const entry of entries) {
    signal.throwIfAborted();
    const name = NodePath.relative(folder, NodePath.join(entry.parentPath, entry.name))
      .split(NodePath.sep)
      .join("/");
    if (entry.isSymbolicLink()) {
      files.push({
        path: name.slice(0, 4096),
        status: "unchecked",
        message: "The package contains a symbolic link.",
      });
    } else if (
      !entry.isDirectory() &&
      !expected.has(name) &&
      !(entry.isFile() && ignoredMetadataFiles.has(entry.name.toLowerCase()))
    ) {
      files.push({
        path: name.slice(0, 4096),
        status: "unlisted",
        message: "This file is not listed and was not copied.",
      });
    }
  }
  return { workspace, reference, results, files, packages };
}
