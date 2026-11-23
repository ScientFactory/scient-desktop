// @effect-diagnostics nodeBuiltinImport:off -- portable package publication stages files on the host.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ComputeResultParameter,
  ComputeResultRevision,
  ResultHandoffExportProgress,
  ResultHandoffManifest,
} from "@t3tools/contracts";

import { sha256File, type ResultsReader } from "../resultRevisions.ts";
import { crateMetadata } from "./crateMetadata.ts";
import {
  copyPackageFile,
  handoffRefusal,
  hashBytes,
  includedDataPath,
  MAXIMUM_SOURCE_BYTES,
  jsonText,
  packagePath,
  publishJson,
  regularPackageFile,
  relativePackagePath,
  isPortablePackagePath,
} from "./handoffFiles.ts";
import { containsHomePath, exportHandoffLockfiles } from "./handoffEnvironment.ts";
import { exportHandoffCode, exportHandoffInputs, listHandoffInputs } from "./handoffInputs.ts";
import { portableNotebook } from "./notebookSource.ts";

const VERSION = /^[\w.+ -]{1,120}$/u;

function parametersWithoutHostPaths(parameters: ReadonlyArray<ComputeResultParameter>) {
  const check = (value: unknown): void => {
    if (typeof value === "string") {
      if (
        containsHomePath(value) ||
        /(?:^|[\s=:"'(<,[])(?:file:|[a-z]:[/\\]|\\\\|\/(?![/\s]))/iu.test(value) ||
        value === "/"
      ) {
        throw handoffRefusal(
          "A recorded parameter uses an absolute path. Run the source with a project-relative path before exporting.",
        );
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        check(key);
        check(item);
      }
    }
  };
  for (const parameter of parameters) {
    check(parameter.name);
    check(JSON.parse(parameter.value));
  }
  return parameters;
}

function readme(manifest: Omit<ResultHandoffManifest, "documentation">): string {
  const included = manifest.inputs.filter((file) => file.included);
  const excluded = manifest.inputs.filter((file) => !file.included);
  const runtime = [manifest.source.language, manifest.runtime.version].filter(Boolean).join(" ");
  const parameters =
    manifest.parameters?.filter((parameter) => parameter.source === "override") ?? [];
  const parameterJson = `{${parameters.map(({ name, value }) => `${JSON.stringify(name)}:${value}`).join(",")}}`;
  const elapsed =
    manifest.run.startedAt === null
      ? null
      : Date.parse(manifest.run.finishedAt) - Date.parse(manifest.run.startedAt);
  const runInstructions =
    manifest.source.kind === "notebook"
      ? "Open the notebook with a matching kernel and run its code cells from top to bottom in a fresh session. The cells already contain the settings used for the recorded run."
      : "Run the script from the new working folder with the matching language runtime. For Python use `python <script path>`; for R use `Rscript <script path>`.";
  return [
    "# Scient result package",
    "",
    `Source: ${manifest.source.path}`,
    `Saved result: ${manifest.revision} (${manifest.run.finishedAt})`,
    "",
    "## Data availability and provenance",
    "",
    "Included inputs are copies chosen by the exporter. Obtain any files listed as supplied separately through an authorized source. The manifest records file sizes and SHA-256 digests.",
    "",
    "## Computational requirements",
    "",
    `Runtime: ${runtime}`,
    ...(elapsed !== null && Number.isFinite(elapsed) && elapsed >= 0
      ? [`Recorded run time: ${elapsed / 1000} seconds.`]
      : []),
    "See `environment/` for available lockfiles and package versions. Memory use and random seeds were not recorded. Check the source for seed settings.",
    "",
    ...(manifest.environment.omittedRuntimeInputs === undefined
      ? []
      : [
          `${manifest.environment.omittedRuntimeInputs} recorded environment files are not listed as data inputs.`,
        ]),
    ...manifest.environment.lockfiles.flatMap((file) =>
      file.prefixRemoved
        ? [`- ${file.path}: The machine-specific prefix was removed.`]
        : file.excludedReason === "private-path"
          ? [`- ${file.path}: Excluded because it contains a home-folder path.`]
          : [],
    ),
    "",
    "## Run it again",
    "",
    "Run code only if you trust its source. It can access files and services available to your account.",
    "",
    "1. Make a new working folder. Copy the contents of `source/` into it, keeping their relative paths. Copy each included data file from the package path to the project path shown below. A project path already starting with `data/` uses that same path in the package.",
    "2. Supply any missing data at the paths listed below and check its SHA-256 against the manifest.",
    "3. Set up the runtime and dependencies. See `environment/` and the manifest for the evidence available from the original run.",
    "4. Set `SCIENT_RESULTS_DIR` to a new empty output folder. Never use the package's saved outputs folder.",
    `5. ${runInstructions}`,
    "",
    ...(parameters.length === 0
      ? []
      : ["Set `SCIENT_PARAMETERS` to this JSON before running:", "", `    ${parameterJson}`, ""]),
    "## Source files",
    "",
    ...[manifest.source, ...(manifest.code ?? [])].map(({ path }) => `- source/${path}`),
    "",
    "## Dataset and input files",
    "",
    ...manifest.inputs
      .filter((file) => file.changedSinceRun || file.hashAtExport)
      .map((file) =>
        file.changedSinceRun
          ? `- ${file.path} changed since the run. This package describes the file at export.`
          : `- The digest for ${file.path} was computed at export.`,
      ),
    "",
    ...included.map(
      (file) =>
        `- Included: package \`${includedDataPath(file.path, manifest.version)}\` → working folder \`${file.path}\` (${file.size} bytes, ${file.origin}${file.via === undefined ? "" : ` through ${file.via}`})`,
    ),
    ...excluded.map(
      (file) =>
        `- Supply separately: ${file.path} (${file.size} bytes, ${file.origin}${file.via === undefined ? "" : ` through ${file.via}`}, ${file.sha256 === null ? "no recorded digest" : `SHA-256 ${file.sha256}`}${file.changedDuringRun ? ", changed during the run" : ""})`,
    ),
    ...(manifest.inputs.length === 0 ? ["No project input files were recorded."] : []),
    ...(manifest.inputTracking === "not-tracked" || manifest.inputsTruncated
      ? ["The original input record is incomplete. Other dependencies may be needed."]
      : []),
    "",
    "## Outputs",
    "",
    ...manifest.outputs.map(
      (output) => `- ${output.pruned ? "Unavailable" : "Saved"}: ${output.name} (${output.kind})`,
    ),
    ...(manifest.skippedOutputs ?? []).map((name) => `- Skipped: ${name} (unsupported file name)`),
    ...(manifest.outputsOmitted > 0 || manifest.outputs.some((output) => output.pruned)
      ? [
          "The original output record is incomplete. See the manifest for omitted or pruned outputs.",
        ]
      : []),
    "",
  ].join("\n");
}

export async function exportResultPackage(options: {
  readonly reader: ResultsReader;
  readonly revision: ComputeResultRevision;
  readonly projectRoot: string;
  readonly destination: string;
  readonly includeInputs: ReadonlyArray<string>;
  readonly excludeLockfiles?: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly scientVersion: string;
  readonly recordedScript?: string;
  readonly recordedCells?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ResultHandoffExportProgress) => void;
}) {
  const { reader, revision } = options;
  const project = await NodeFSP.realpath(options.projectRoot);
  const root = await NodeFSP.realpath(options.destination);
  const sourcePath = relativePackagePath(revision.script.path);
  const source = await regularPackageFile(project, sourcePath);
  const sourceKind = revision.script.kind ?? "script";
  const sourceError = handoffRefusal(
    "The saved source does not match this run. Restore the exact source or run the saved file again.",
  );
  const saved =
    source === null || (await NodeFSP.stat(source)).size > MAXIMUM_SOURCE_BYTES
      ? null
      : await NodeFSP.readFile(source);
  const sourceBytes =
    sourceKind === "notebook"
      ? portableNotebook(
          saved?.toString("utf8") ?? null,
          revision.script.sha256,
          options.recordedCells,
        )
      : saved !== null && hashBytes(saved) === revision.script.sha256
        ? saved
        : (options.recordedScript ?? null);
  if (sourceBytes === null || Buffer.byteLength(sourceBytes) > MAXIMUM_SOURCE_BYTES)
    throw sourceError;
  const sourceHash = hashBytes(sourceBytes);
  if (sourceKind === "script" && sourceHash !== revision.script.sha256) throw sourceError;

  const {
    files: inputFiles,
    code: codeFiles,
    omitted: omittedRuntimeInputs,
  } = await listHandoffInputs(project, revision);
  const parameters =
    revision.parameters === undefined ? undefined : parametersWithoutHostPaths(revision.parameters);
  const pending = await NodeFSP.mkdtemp(NodePath.join(root, ".scient-result-"));
  const folder = NodePath.join(
    root,
    `result-${revision.revision}-${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  try {
    for (const name of ["source", "outputs", "environment"]) {
      await NodeFSP.mkdir(NodePath.join(pending, name));
    }
    const sourceTarget = packagePath(pending, `source/${sourcePath}`);
    await NodeFSP.mkdir(NodePath.dirname(sourceTarget), { recursive: true });
    await NodeFSP.writeFile(sourceTarget, sourceBytes, { flag: "wx" });

    const code = await exportHandoffCode(project, pending, codeFiles, options.signal);
    const inputs = await exportHandoffInputs({
      project,
      pending,
      files: inputFiles,
      includeInputs: options.includeInputs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    const warnings = inputs
      .filter((input) => input.changedSinceRun)
      .map((input) => `${input.path} changed since the run. The package records the current file.`);

    const outputs = revision.outputs.filter((output) => isPortablePackagePath(output.name));
    const skippedOutputs = revision.outputs
      .filter((output) => !isPortablePackagePath(output.name))
      .map((output) => (containsHomePath(output.name) ? "[unsafe output name]" : output.name));
    for (const name of skippedOutputs)
      warnings.push(`Skipped output with an unsupported file name: ${name}.`);
    for (const output of outputs) {
      if (output.pruned) continue;
      const stored = await reader.outputFile(revision, output.name);
      if (
        stored === null ||
        !(await copyPackageFile(
          stored.path,
          pending,
          `outputs/${output.name}`,
          output.sha256,
          output.size,
        ))
      ) {
        throw handoffRefusal(`The saved output ${output.name} does not match its record.`);
      }
    }

    const environment = await exportHandoffLockfiles(
      project,
      pending,
      revision,
      options.excludeLockfiles ?? [],
    );
    const { lockfiles } = environment;
    warnings.push(...environment.warnings);
    const licenseFile = await regularPackageFile(project, "LICENSE");
    const licenseTarget = NodePath.join(pending, "LICENSE");
    let license: ResultHandoffManifest["license"];
    if (licenseFile !== null) {
      await NodeFSP.copyFile(licenseFile, licenseTarget);
      license = {
        sha256: await sha256File(licenseTarget),
        size: (await NodeFSP.stat(licenseTarget)).size,
      };
    }
    const packages = revision.environment?.packages;
    const packageList =
      packages === undefined
        ? undefined
        : jsonText(
            packages.filter((entry) => VERSION.test(entry.name) && VERSION.test(entry.version)),
          );
    if (packageList !== undefined) {
      await NodeFSP.writeFile(NodePath.join(pending, "environment/packages.json"), packageList, {
        flag: "wx",
      });
    }

    const manifest: Omit<ResultHandoffManifest, "documentation"> = {
      version: 2,
      revision: revision.revision,
      createdAt: options.createdAt,
      scientVersion: options.scientVersion,
      run: { startedAt: revision.run.startedAt, finishedAt: revision.run.finishedAt },
      source: {
        path: sourcePath,
        kind: sourceKind,
        language: revision.script.language,
        sha256: revision.script.sha256,
        fileSha256: sourceHash,
        size: Buffer.byteLength(sourceBytes),
      },
      ...(code.length === 0 ? {} : { code }),
      runtime: {
        version:
          revision.runtime.version !== null && VERSION.test(revision.runtime.version)
            ? revision.runtime.version
            : null,
      },
      ...(parameters === undefined ? {} : { parameters }),
      inputs,
      inputTracking: revision.inputs.tracking,
      inputsTruncated: revision.inputs.truncated,
      outputs,
      outputsOmitted: revision.omitted + skippedOutputs.length,
      ...(skippedOutputs.length === 0 ? {} : { skippedOutputs }),
      ...(license === undefined ? {} : { license }),
      environment: {
        lockfiles,
        ...(omittedRuntimeInputs === 0 ? {} : { omittedRuntimeInputs }),
        ...(packageList === undefined ? {} : { packageListSha256: hashBytes(packageList) }),
        ...(revision.environment?.packagesTruncated === true ||
        packages?.some((entry) => !VERSION.test(entry.name) || !VERSION.test(entry.version))
          ? { packagesTruncated: true }
          : {}),
      },
    };
    const instructions = readme(manifest);
    const finalized: ResultHandoffManifest = {
      ...manifest,
      documentation: { readmeSha256: hashBytes(instructions), crateSha256: "0".repeat(64) },
    };
    const sizes = new Map([
      ["README.md", Buffer.byteLength(instructions)],
      ["manifest.json", Buffer.byteLength(jsonText(finalized))],
    ]);
    if (packageList !== undefined)
      sizes.set("environment/packages.json", Buffer.byteLength(packageList));
    for (const lockfile of lockfiles) {
      if (!lockfile.included) continue;
      const path = `environment/lockfiles/${lockfile.path}`;
      sizes.set(path, (await NodeFSP.stat(packagePath(pending, path))).size);
    }
    const crate = jsonText(crateMetadata(manifest, sizes));
    await NodeFSP.writeFile(NodePath.join(pending, "README.md"), instructions, { flag: "wx" });
    await NodeFSP.writeFile(NodePath.join(pending, "ro-crate-metadata.json"), crate, {
      flag: "wx",
    });
    await publishJson(NodePath.join(pending, "manifest.json"), {
      ...finalized,
      documentation: { ...finalized.documentation, crateSha256: hashBytes(crate) },
    });
    await NodeFSP.rename(pending, folder);
    return { folder, ...(warnings.length === 0 ? {} : { warnings }) };
  } finally {
    await NodeFSP.rm(pending, { recursive: true, force: true }).catch(() => undefined);
  }
}
