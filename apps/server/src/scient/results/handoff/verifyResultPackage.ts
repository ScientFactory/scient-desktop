// @effect-diagnostics nodeBuiltinImport:off -- verification uses an isolated scratch directory and publishes a report beside the package.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ResultHandoffManifest,
  ResultHandoffOutputFinding,
  ResultHandoffVerification,
  ResultHandoffVerifyInput,
  ResultHandoffVerifyResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { ExecutionProcess } from "../../execution/LocalExecutionProcess.ts";
import { sha256File } from "../resultRevisions.ts";
import { comparePackageValues } from "./comparePackageValues.ts";
import {
  copyFileExclusively,
  handoffRefusal,
  isHandoffRefusal,
  packagePath,
  publishJson,
  regularPackageFile,
} from "./handoffFiles.ts";
import { runPackage } from "./handoffRuntime.ts";
import {
  readPackageManifest,
  stageVerificationFiles,
  type VerifiedPackageFiles,
} from "./verificationFiles.ts";

const MAX_VALUES_BYTES = 4 * 1024 * 1024;
const MAX_FIGURE_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_INLINE_PAIRS = 4;

type Figure = { name: string; mediaType: string; original: string; rerun: string };

function skippedOutputFindings(manifest: ResultHandoffManifest): ResultHandoffOutputFinding[] {
  return [...new Set(manifest.skippedOutputs)].map((path) => ({
    path,
    status: "unchecked",
    message: "This file name could not be carried in the package.",
  }));
}

async function compareOutputs(
  manifest: ResultHandoffManifest,
  files: VerifiedPackageFiles,
  tolerance: { readonly absolute: number; readonly relative: number },
  signal: AbortSignal,
) {
  const outputs: ResultHandoffOutputFinding[] = [];
  const figures: Figure[] = [];
  for (const output of manifest.outputs) {
    signal.throwIfAborted();
    const path = output.name;
    if (output.pruned) {
      outputs.push({
        path,
        status: "unchecked",
        message: "The original output bytes were unavailable.",
      });
      continue;
    }
    const rerun = await regularPackageFile(files.results, path);
    if (rerun === null) {
      outputs.push({ path, status: "missing", message: "The rerun did not write this file." });
      continue;
    }
    const original = packagePath(files.reference, path);
    const rerunSize = (await NodeFSP.stat(rerun)).size;
    if (rerunSize > MAX_FIGURE_BYTES) {
      outputs.push({
        path,
        status: "differs",
        message: "The rerun file exceeds the retained output size limit.",
      });
      continue;
    }
    const sha256 = await sha256File(rerun, signal);
    if (output.kind !== "values" && sha256 === output.sha256) {
      outputs.push({ path, status: "matched", sha256 });
      continue;
    }
    if (
      output.kind === "values" &&
      rerunSize <= MAX_VALUES_BYTES &&
      output.size <= MAX_VALUES_BYTES
    ) {
      try {
        const before = await NodeFSP.readFile(original, { encoding: "utf8", signal });
        const after = await NodeFSP.readFile(rerun, { encoding: "utf8", signal });
        const comparison = comparePackageValues(before, after, tolerance);
        outputs.push({
          path,
          status: comparison.differenceCount === 0 ? "matched" : "differs",
          sha256,
          ...comparison,
        });
      } catch {
        signal.throwIfAborted();
        outputs.push({
          path,
          status: "differs",
          sha256,
          message: "The rerun output could not be compared as JSON values.",
        });
      }
      continue;
    }
    if (output.kind === "figure") {
      if (rerunSize <= MAX_FIGURE_BYTES) {
        figures.push({ name: path, mediaType: output.mediaType, original, rerun });
      }
      outputs.push({
        path,
        status: "differs",
        sha256,
        message: "Figure bytes differ. Compare the saved and rerun figures.",
      });
    } else {
      outputs.push({ path, status: "differs", sha256, message: "The file's bytes differ." });
    }
  }
  return { outputs: [...outputs, ...skippedOutputFindings(manifest)], figures };
}

async function writeVerification(
  folder: string,
  report: ResultHandoffVerification,
  differences: ReadonlyArray<Figure>,
  signal: AbortSignal,
): Promise<ResultHandoffVerifyResult> {
  signal.throwIfAborted();
  const destination = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(folder), "result-verification-"),
  );
  const figures: ResultHandoffVerifyResult["figures"][number][] = [];
  try {
    for (const difference of differences) {
      const originalPath = packagePath(destination, `original/${difference.name}`);
      const rerunPath = packagePath(destination, `rerun/${difference.name}`);
      for (const [source, target] of [
        [difference.original, originalPath],
        [difference.rerun, rerunPath],
      ] as const) {
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await copyFileExclusively(source, target, signal);
      }
      const canPreview =
        figures.length < MAX_INLINE_PAIRS &&
        ["image/png", "image/jpeg", "image/svg+xml"].includes(difference.mediaType) &&
        (await NodeFSP.stat(originalPath)).size <= MAX_PREVIEW_BYTES &&
        (await NodeFSP.stat(rerunPath)).size <= MAX_PREVIEW_BYTES;
      const previews = canPreview
        ? {
            originalPreview: (await NodeFSP.readFile(originalPath, { signal })).toString("base64"),
            rerunPreview: (await NodeFSP.readFile(rerunPath, { signal })).toString("base64"),
          }
        : {};
      figures.push({
        name: difference.name,
        mediaType: difference.mediaType,
        originalPath,
        rerunPath,
        ...previews,
      });
    }
    const reportPath = NodePath.join(destination, "verification.json");
    await publishJson(reportPath, report, signal);
    return { report, reportPath, figures };
  } catch (error) {
    await NodeFSP.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function environmentDifferences(
  manifest: ResultHandoffManifest,
  files: VerifiedPackageFiles,
  environment: NonNullable<ResultHandoffVerification["environment"]>,
) {
  const changes: ResultHandoffVerification["environmentChanges"][number][] = [];
  const comparableVersion = (version: string | null) =>
    version?.replace(/^(?:Python|Rscript \(R\)|julia) (?:version )?/iu, "") ?? null;
  if (
    manifest.runtime.version !== null &&
    comparableVersion(manifest.runtime.version) !== comparableVersion(environment.version)
  ) {
    changes.push({
      name: environment.language,
      recorded: manifest.runtime.version,
      rerun: environment.version,
    });
  }
  if (files.packages === undefined || environment.packages === undefined) return changes;
  const packageMap = (packages: NonNullable<VerifiedPackageFiles["packages"]>) =>
    new Map(
      packages.map(({ name, version }) => [name.toLowerCase().replace(/[-_.]+/gu, "-"), version]),
    );
  const recorded = packageMap(files.packages);
  const rerun = packageMap(environment.packages);
  const names = manifest.environment.packagesTruncated
    ? recorded.keys()
    : new Set([...recorded.keys(), ...rerun.keys()]);
  for (const name of names) {
    const left = recorded.get(name) ?? null;
    const right = rerun.get(name) ?? null;
    if (left !== right) changes.push({ name, recorded: left, rerun: right });
  }
  return changes;
}

const refuse = (message: string) => (cause: unknown) =>
  isHandoffRefusal(cause) ? cause : handoffRefusal(message);

const verifyFiles = Effect.fn("ResultHandoff.verifyFiles")(
  <A>(work: (signal: AbortSignal) => Promise<A>, message: string) =>
    Effect.callback<A, ReturnType<typeof handoffRefusal>>((resume, signal) => {
      const pending = work(signal).then(
        (value) => resume(Effect.succeed(value)),
        (cause: unknown) => resume(Effect.fail(refuse(message)(cause))),
      );
      // The runtime aborts the signal before joining the file operation and removing scratch.
      return Effect.promise(() => pending);
    }),
);

export const verifyResultPackage = Effect.fn("ResultHandoff.verifyPackage")(function* (
  process: ExecutionProcess["Service"],
  input: ResultHandoffVerifyInput,
  selectExecutable?: (language: string) => Effect.Effect<string | undefined>,
  controls?: {
    readonly cancellation: Deferred.Deferred<void>;
    readonly finish: Effect.Effect<void>;
  },
) {
  if (
    input.allowExecution !== true ||
    ![input.packageFolder, input.inputsFolder, input.executable].every(
      (path) => path === undefined || NodePath.isAbsolute(path),
    )
  ) {
    return yield* handoffRefusal(
      "Choose absolute paths on the Compute computer and confirm the code can run.",
    );
  }
  const folder = yield* Effect.tryPromise({
    try: async () => {
      const root = await NodeFSP.realpath(input.packageFolder);
      if (!(await NodeFSP.stat(root)).isDirectory() || root === NodePath.dirname(root)) {
        throw handoffRefusal("Choose a result package folder.");
      }
      return root;
    },
    catch: refuse("The result package folder could not be opened."),
  });
  const rawFolder = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-result-")),
      catch: refuse("A temporary working folder could not be created."),
    }),
    (path) =>
      Effect.promise(() =>
        NodeFSP.rm(path, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
  const scratch = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(rawFolder),
    catch: refuse("The temporary working folder could not be opened."),
  });
  const tolerance = {
    absolute: input.absoluteTolerance ?? 1e-12,
    relative: input.relativeTolerance ?? 1e-9,
  };
  const timeoutMinutes = input.timeoutMinutes ?? 60;
  const cancellation = controls?.cancellation;
  const didCancel =
    cancellation === undefined ? Effect.succeed(false) : Deferred.isDone(cancellation);
  const untilCancelled = <A, E>(effect: Effect.Effect<A, E>) =>
    cancellation === undefined
      ? effect.pipe(Effect.result)
      : Effect.raceFirst(
          effect.pipe(Effect.result),
          Deferred.await(cancellation).pipe(Effect.as(null)),
        );
  const verifiedAt = DateTime.formatIso(yield* DateTime.now);
  const verifierName = input.verifierName?.trim();
  const base = {
    version: 1 as const,
    verifiedAt,
    timeoutMinutes,
    absoluteTolerance: tolerance.absolute,
    relativeTolerance: tolerance.relative,
    ...(verifierName ? { verifierName } : {}),
  };
  const result = yield* Effect.gen(function* () {
    const parsed = yield* Effect.tryPromise({
      try: () => readPackageManifest(folder),
      catch: refuse("The manifest is invalid or uses an unsupported version."),
    }).pipe(Effect.result);
    if (Result.isFailure(parsed)) {
      return {
        report: {
          ...base,
          revision: null,
          files: [],
          outputs: [],
          environment: null,
          environmentChanges: [],
          status: "could-not-run",
          message: parsed.failure.message,
        },
        figures: [],
      } satisfies { report: ResultHandoffVerification; figures: ReadonlyArray<Figure> };
    }
    const manifest = parsed.success;
    const report = { ...base, revision: manifest.revision };
    const couldNotRun = (
      message: string,
      files: VerifiedPackageFiles["files"] = [],
      environment: ResultHandoffVerification["environment"] = null,
      status: "could-not-run" | "cancelled" = "could-not-run",
    ) => ({
      report: {
        ...report,
        files,
        outputs: [
          ...manifest.outputs.map((output) => ({
            path: output.name,
            status: "unchecked" as const,
          })),
          ...skippedOutputFindings(manifest),
        ],
        environment,
        environmentChanges: [],
        status,
        message,
      },
      figures: [],
    });
    const cancelled = (files: VerifiedPackageFiles["files"] = []) =>
      couldNotRun("Verification was cancelled.", files, null, "cancelled");
    if (yield* didCancel) return cancelled();
    const staged = yield* untilCancelled(
      verifyFiles(
        (signal) => stageVerificationFiles(folder, scratch, manifest, input, signal),
        "The package files could not be copied or checked.",
      ),
    );
    if (staged === null) return cancelled();
    if (yield* didCancel) return cancelled(Result.isSuccess(staged) ? staged.success.files : []);
    if (Result.isFailure(staged)) {
      return couldNotRun(staged.failure.message);
    }
    const files = staged.success;
    if (files.files.some((file) => file.status !== "matched" && file.status !== "unlisted")) {
      return couldNotRun(
        "Some expected files are missing, changed, or cannot be checked.",
        files.files,
      );
    }
    const rerun = Effect.gen(function* () {
      const executable =
        input.executable ??
        (yield* selectExecutable?.(manifest.source.language) ?? Effect.undefined);
      return yield* runPackage(process, manifest, files, executable, timeoutMinutes);
    });
    const ran = yield* untilCancelled(rerun);
    if (ran === null || (yield* didCancel)) return cancelled(files.files);
    if (Result.isFailure(ran)) return couldNotRun(ran.failure.message, files.files);
    const { environment, problem } = ran.success;
    if (problem !== null) return couldNotRun(problem, files.files, environment);
    const comparison = yield* untilCancelled(
      verifyFiles(
        (signal) => compareOutputs(manifest, files, tolerance, signal),
        "The rerun finished, but its files could not be compared.",
      ),
    );
    if (comparison === null || (yield* didCancel)) return cancelled(files.files);
    if (Result.isFailure(comparison)) {
      return couldNotRun(comparison.failure.message, files.files, environment);
    }
    const { outputs, figures } = comparison.success;
    const kinds = new Map(manifest.outputs.map((output) => [output.name, output.kind]));
    const deciding = outputs.filter(
      (output) => kinds.get(output.path) !== "figure" && output.status !== "unchecked",
    );
    const figureOutputs = outputs.filter((output) => kinds.get(output.path) === "figure");
    const differingFigures = figureOutputs.some(
      (output) => output.status === "differs" || output.status === "missing",
    );
    const matchedFigures = figureOutputs.some((output) => output.status === "matched");
    const hasUnchecked =
      manifest.outputsOmitted > 0 || outputs.some((output) => output.status === "unchecked");
    const status: ResultHandoffVerification["status"] =
      deciding.length === 0
        ? "could-not-run"
        : deciding.some((output) => output.status !== "matched")
          ? "differs"
          : "verified";
    const message =
      deciding.length === 0
        ? differingFigures
          ? "The rerun finished with no retained values, tables, or data files to verify automatically. Review the differing figures."
          : matchedFigures
            ? "The rerun finished and figure bytes matched, with no retained values, tables, or data files to verify automatically."
            : "The rerun finished. There were no retained values, tables, or other files to confirm."
        : status === "verified"
          ? differingFigures && hasUnchecked
            ? "Checked values, tables, and data files matched. Some figures need review, and some original outputs were unavailable."
            : differingFigures
              ? "Checked values, tables, and data files matched. Figures differ and need visual review."
              : hasUnchecked
                ? "Checked values, tables, and data files matched. Some original outputs were unavailable."
                : undefined
          : hasUnchecked
            ? "Some original outputs were unavailable. Comparison covers the retained outputs."
            : undefined;
    const environmentChanges = environmentDifferences(manifest, files, environment);
    return {
      report: {
        ...report,
        files: files.files,
        outputs,
        environment,
        environmentChanges,
        status,
        ...(deciding.length === 0 ? { rerunCompleted: true } : {}),
        ...(message === undefined ? {} : { message }),
      },
      figures,
    };
  });
  if (controls !== undefined) yield* controls.finish;
  return yield* verifyFiles(
    (signal) => writeVerification(folder, result.report, result.figures, signal),
    "The verification report could not be saved beside the package.",
  );
}, Effect.scoped);
