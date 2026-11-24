// @effect-diagnostics nodeBuiltinImport:off -- inputs are streamed from the project filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ComputeResultRevision,
  ResultHandoffExportProgress,
  ResultHandoffInputFile,
} from "@t3tools/contracts";

import {
  copyPackageFile,
  handoffRefusal,
  includedDataPath,
  isPortablePackagePath,
  regularPackageFile,
  relativeInputPath,
} from "./handoffFiles.ts";

type RecordedInput = ComputeResultRevision["inputs"]["files"][number];

const codeExtensions = new Set([".py", ".r", ".jl", ".m"]);

const runtimeFolders = new Set(["site-packages", "dist-packages", "__pycache__"]);

export async function listHandoffInputs(root: string, revision: ComputeResultRevision) {
  const venvs = new Map<string, boolean>();
  const files: RecordedInput[] = [];
  const code: RecordedInput[] = [];
  let omitted = 0;
  for (const input of revision.inputs.files) {
    const path = relativeInputPath(input.path);
    const parts = path.split("/");
    const folders = parts.slice(0, -1);
    let runtime = folders.some((part) => runtimeFolders.has(part.toLowerCase()));
    for (let depth = 1; depth <= folders.length && !runtime; depth++) {
      const folder = folders.slice(0, depth).join("/");
      let venv = venvs.get(folder);
      if (venv === undefined) {
        venv = (await regularPackageFile(root, `${folder}/pyvenv.cfg`, "input")) !== null;
        venvs.set(folder, venv);
      }
      runtime = venv;
    }
    if (runtime || revision.environment?.lockfiles.some((file) => file.path === path)) omitted++;
    else if (path !== revision.script.path) {
      if (input.origin !== "declared" && codeExtensions.has(NodePath.extname(path).toLowerCase())) {
        code.push(input);
      } else {
        files.push(input);
      }
    }
  }
  return { files, code, omitted };
}

function recordedFields(input: RecordedInput): ResultHandoffInputFile {
  return {
    path: input.path,
    size: input.size,
    sha256: input.sha256,
    origin: input.origin ?? "observed",
    changedDuringRun: input.changedDuringRun,
    ...(input.via === undefined ? {} : { via: relativeInputPath(input.via) }),
  };
}

async function currentFile(root: string, input: RecordedInput) {
  if (NodePath.sep === "\\" && !isPortablePackagePath(input.path)) return null;
  return regularPackageFile(root, input.path, "input");
}

const changed = (input: RecordedInput, status: NodeFS.BigIntStats) =>
  BigInt(input.size) !== status.size || input.modifiedAtNs !== status.mtimeNs.toString();

export async function handoffInputChoices(root: string, revision: ComputeResultRevision) {
  const canonical = await NodeFSP.realpath(root);
  const { files, code } = await listHandoffInputs(canonical, revision);
  const inputs = await Promise.all(
    files.map(async (input) => {
      const file = await currentFile(canonical, input);
      const status =
        file === null ? null : await NodeFSP.stat(file, { bigint: true }).catch(() => null);
      return {
        ...recordedFields(input),
        copyAvailable: status?.isFile() === true && isPortablePackagePath(input.path),
        ...(status !== null && changed(input, status)
          ? { changedSinceRun: true, size: Number(status.size) }
          : {}),
      };
    }),
  );
  return { inputs, code: code.map((file) => file.path) };
}

async function hashInput(
  file: string,
  signal: AbortSignal | undefined,
  advance: (length: number) => void,
) {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const status = await handle.stat({ bigint: true });
    if (!status.isFile()) throw handoffRefusal("A recorded input is no longer a regular file.");
    const hash = NodeCrypto.createHash("sha256");
    for await (const bytes of handle.createReadStream({
      autoClose: false,
      ...(signal === undefined ? {} : { signal }),
    })) {
      hash.update(bytes as Buffer);
      advance((bytes as Buffer).length);
    }
    const after = await handle.stat({ bigint: true });
    if (
      status.size !== after.size ||
      status.mtimeNs !== after.mtimeNs ||
      status.ctimeNs !== after.ctimeNs
    ) {
      throw handoffRefusal("An input changed while Scient read it. Try exporting again.");
    }
    return { status, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function exportHandoffCode(
  project: string,
  pending: string,
  sources: ReadonlyArray<RecordedInput>,
  signal?: AbortSignal,
) {
  const code = [];
  for (const input of sources) {
    signal?.throwIfAborted();
    const unavailable = handoffRefusal(
      `The recorded code ${input.path} cannot be copied. Restore the original file or run the source again.`,
    );
    const file = isPortablePackagePath(input.path) ? await currentFile(project, input) : null;
    if (file === null || input.changedDuringRun) throw unavailable;
    const { status, sha256 } = await hashInput(file, signal, () => undefined);
    if (input.sha256 === null ? changed(input, status) : input.sha256 !== sha256) {
      throw unavailable;
    }
    const size = Number(status.size);
    if (!(await copyPackageFile(file, pending, `source/${input.path}`, sha256, size))) {
      throw unavailable;
    }
    code.push({ path: input.path, sha256, size });
  }
  return code;
}

export async function exportHandoffInputs(options: {
  readonly project: string;
  readonly pending: string;
  readonly files: ReadonlyArray<RecordedInput>;
  readonly includeInputs: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ResultHandoffExportProgress) => void;
}) {
  const { project, pending, files, signal, onProgress } = options;
  const selected = new Set(options.includeInputs);
  if ([...selected].some((path) => !files.some((file) => file.path === path))) {
    throw handoffRefusal("Choose data inputs recorded for this result.");
  }
  const targets = new Set(
    [...selected].map((path) => includedDataPath(path).normalize("NFC").toLowerCase()),
  );
  if (
    targets.size !== selected.size ||
    [...targets].some((target) => {
      const parts = target.split("/");
      return parts.some(
        (_part, index) => index > 0 && targets.has(parts.slice(0, index).join("/")),
      );
    })
  ) {
    throw handoffRefusal(
      "Selected data files would share a path in the package. Copy one and supply the other separately.",
    );
  }
  let bytesHashed = 0;
  let filesHashed = 0;
  const progress = () => onProgress?.({ bytesHashed, filesHashed, totalFiles: files.length });
  progress();
  const inputs = [];
  for (const input of files) {
    signal?.throwIfAborted();
    const file = await currentFile(project, input);
    const included = selected.has(input.path);
    const original = recordedFields(input);
    if (included && (!isPortablePackagePath(input.path) || file === null)) {
      throw handoffRefusal(
        `The input ${input.path} cannot be copied. Clear it from the selection or restore the file.`,
      );
    }
    if (file === null) {
      inputs.push({ ...original, included: false });
    } else {
      const { status, sha256 } = await hashInput(file, signal, (length) => {
        bytesHashed += length;
        progress();
      });
      const size = Number(status.size);
      const changedSinceRun =
        input.sha256 === null ? changed(input, status) : input.sha256 !== sha256;
      if (
        included &&
        !(await copyPackageFile(file, pending, includedDataPath(input.path), sha256, size))
      ) {
        throw handoffRefusal(`The input ${input.path} changed during export. Try again.`);
      }
      inputs.push({
        ...original,
        included,
        exportFile: { size, sha256 },
        ...(changedSinceRun ? { changedSinceRun: true } : {}),
      });
    }
    filesHashed++;
    progress();
  }
  return inputs;
}
