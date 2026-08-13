// @effect-diagnostics nodeBuiltinImport:off -- promotion is an atomic host-filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  analysisRunCapsuleDirectory,
  analysisRunOutputText,
  buildAnalysisRunCapsuleManifest,
  renderAnalysisRunCapsuleReadme,
  type AnalysisRunCapsuleArtifactRepresentation,
  type AnalysisRunSnapshot,
} from "@scientfactory/analysis";
import { executionOutputContentParts } from "@scientfactory/execution";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { LocalAnalysisStore } from "./LocalAnalysisStore.ts";

const README_FILE_NAME = "README.md";
const MANIFEST_FILE_NAME = "manifest.json";
const OUTPUT_FILE_NAME = "output.txt";
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJsonString = Schema.decodeUnknownOption(UnknownJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownSync(UnknownJsonString);

export class AnalysisRunPromotionError extends Schema.TaggedErrorClass<AnalysisRunPromotionError>()(
  "AnalysisRunPromotionError",
  {
    reason: Schema.Literals(["run-data-unavailable", "destination-exists", "persistence-failed"]),
    message: Schema.NonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isAnalysisRunPromotionError = Schema.is(AnalysisRunPromotionError);

export interface AnalysisRunPromotionResult {
  readonly directoryRelativePath: string;
  readonly readmeRelativePath: string;
  readonly manifestRelativePath: string;
  readonly artifactFileCount: number;
  readonly reused: boolean;
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

function sha256Text(contents: string): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(contents, "utf8").digest("hex")}`;
}

function canonicalOutputHash(run: AnalysisRunSnapshot): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of executionOutputContentParts(run.receipt.output)) hash.update(part, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function isNotFound(cause: unknown): boolean {
  return (
    cause instanceof Error && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function ensureDirectoryChainWithoutSymlinks(
  workspaceRoot: string,
  relativeDirectory: string,
): Promise<string> {
  let current = workspaceRoot;
  for (const segment of relativeDirectory.split("/")) {
    current = NodePath.join(current, segment);
    let info: NodeFS.Stats;
    try {
      info = await NodeFSP.lstat(current);
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
      try {
        await NodeFSP.mkdir(current);
      } catch (mkdirCause) {
        if (
          !(mkdirCause instanceof Error) ||
          !("code" in mkdirCause) ||
          (mkdirCause as NodeJS.ErrnoException).code !== "EEXIST"
        ) {
          throw mkdirCause;
        }
      }
      info = await NodeFSP.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AnalysisRunPromotionError({
        reason: "destination-exists",
        message: `Cannot save the run because '${relativeDirectory}' contains a non-directory or symbolic link.`,
      });
    }
  }
  return current;
}

async function existingCapsuleResult(input: {
  readonly directoryPath: string;
  readonly directoryRelativePath: string;
  readonly runId: string;
  readonly artifactFileCount: number;
}): Promise<AnalysisRunPromotionResult | null> {
  let info: NodeFS.Stats;
  try {
    info = await NodeFSP.lstat(input.directoryPath);
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AnalysisRunPromotionError({
      reason: "destination-exists",
      message: `Cannot save the run because '${input.directoryRelativePath}' already exists and is not a project result folder.`,
    });
  }
  try {
    const manifestPath = NodePath.join(input.directoryPath, MANIFEST_FILE_NAME);
    const manifestInfo = await NodeFSP.lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
      throw new AnalysisRunPromotionError({
        reason: "destination-exists",
        message: `Cannot save the run because '${input.directoryRelativePath}' contains an invalid manifest.`,
      });
    }
    const decoded = decodeUnknownJsonString(await NodeFSP.readFile(manifestPath, "utf8"));
    if (Option.isNone(decoded)) {
      throw new AnalysisRunPromotionError({
        reason: "destination-exists",
        message: `Cannot save the run because '${input.directoryRelativePath}' contains an unreadable manifest.`,
      });
    }
    const manifest = decoded.value;
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "capsuleVersion" in manifest &&
      manifest.capsuleVersion === 1 &&
      "kind" in manifest &&
      manifest.kind === "scient-analysis-run" &&
      "run" in manifest &&
      typeof manifest.run === "object" &&
      manifest.run !== null &&
      "runId" in manifest.run &&
      manifest.run.runId === input.runId
    ) {
      for (const requiredFileName of [README_FILE_NAME, OUTPUT_FILE_NAME]) {
        const requiredInfo = await NodeFSP.lstat(
          NodePath.join(input.directoryPath, requiredFileName),
        );
        if (requiredInfo.isSymbolicLink() || !requiredInfo.isFile()) {
          throw new AnalysisRunPromotionError({
            reason: "destination-exists",
            message: `Cannot reuse '${input.directoryRelativePath}' because '${requiredFileName}' is missing or invalid.`,
          });
        }
      }
      return {
        directoryRelativePath: input.directoryRelativePath,
        readmeRelativePath: `${input.directoryRelativePath}/${README_FILE_NAME}`,
        manifestRelativePath: `${input.directoryRelativePath}/${MANIFEST_FILE_NAME}`,
        artifactFileCount: input.artifactFileCount,
        reused: true,
      };
    }
  } catch (cause) {
    if (!isNotFound(cause) && !(cause instanceof SyntaxError)) throw cause;
  }
  throw new AnalysisRunPromotionError({
    reason: "destination-exists",
    message: `Cannot save the run because '${input.directoryRelativePath}' already contains different project files.`,
  });
}

function mapFilesystemFailure(cause: unknown): AnalysisRunPromotionError {
  return isAnalysisRunPromotionError(cause)
    ? cause
    : new AnalysisRunPromotionError({
        reason: "persistence-failed",
        message: "Unable to publish the analysis result into the project.",
        cause,
      });
}

export function promoteAnalysisRun(input: {
  readonly workspaceRoot: string;
  readonly run: AnalysisRunSnapshot;
  readonly createdAt: string;
  readonly store: LocalAnalysisStore["Service"];
}): Effect.Effect<AnalysisRunPromotionResult, AnalysisRunPromotionError> {
  const directoryRelativePath = analysisRunCapsuleDirectory(input.run);
  const directorySegments = directoryRelativePath.split("/");
  const directoryName = directorySegments.at(-1)!;
  const parentRelativePath = directorySegments.slice(0, -1).join("/");
  const artifactFileCount = input.run.artifacts.reduce(
    (count, artifact) => count + artifact.representations.length,
    0,
  );

  return Effect.gen(function* () {
    if (input.run.localStorage.status !== "retained") {
      return yield* new AnalysisRunPromotionError({
        reason: "run-data-unavailable",
        message:
          "This run's local output and artifacts were already removed. Run the file again before saving a project result.",
      });
    }

    const parentPath = yield* Effect.tryPromise({
      try: () => ensureDirectoryChainWithoutSymlinks(input.workspaceRoot, parentRelativePath),
      catch: mapFilesystemFailure,
    });
    const directoryPath = NodePath.join(parentPath, directoryName);
    const existing = yield* Effect.tryPromise({
      try: () =>
        existingCapsuleResult({
          directoryPath,
          directoryRelativePath,
          runId: input.run.receipt.runId,
          artifactFileCount,
        }),
      catch: mapFilesystemFailure,
    });
    if (existing !== null) return existing;

    const stagingName = `.scient-${directoryName}-${NodeCrypto.randomUUID()}.tmp`;
    const stagingPath = NodePath.join(parentPath, stagingName);
    const artifactsPath = NodePath.join(stagingPath, "artifacts");

    const publish = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(stagingPath);
          await NodeFSP.mkdir(artifactsPath);
        },
        catch: mapFilesystemFailure,
      });

      const outputText = analysisRunOutputText(input.run);
      const outputByteLength = Buffer.byteLength(outputText, "utf8");
      const outputContentHash = sha256Text(outputText);
      if (
        input.run.receipt.outputContentHash !== null &&
        canonicalOutputHash(input.run) !== input.run.receipt.outputContentHash
      ) {
        return yield* new AnalysisRunPromotionError({
          reason: "run-data-unavailable",
          message:
            "The local output no longer matches its run receipt. Run the file again before saving a project result.",
        });
      }
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.writeFile(NodePath.join(stagingPath, OUTPUT_FILE_NAME), outputText, {
            encoding: "utf8",
            flag: "wx",
          }),
        catch: mapFilesystemFailure,
      });

      const promotedRepresentations = new Map<string, AnalysisRunCapsuleArtifactRepresentation>();
      for (const artifact of input.run.artifacts) {
        for (const representation of artifact.representations) {
          const resolved = yield* input.store
            .resolveArtifact({
              projectId: input.run.projectId,
              runId: input.run.receipt.runId,
              artifactId: artifact.artifactId,
              representationId: representation.representationId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AnalysisRunPromotionError({
                    reason: "persistence-failed",
                    message: `Unable to read '${representation.fileName}' from the local run store.`,
                    cause,
                  }),
              ),
            );
          if (resolved === null) {
            return yield* new AnalysisRunPromotionError({
              reason: "run-data-unavailable",
              message: `The local artifact '${representation.fileName}' is missing. Run the file again before saving a project result.`,
            });
          }
          const destinationPath = NodePath.join(artifactsPath, representation.fileName);
          const copied = yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.copyFile(
                resolved.path,
                destinationPath,
                NodeFS.constants.COPYFILE_EXCL,
              );
              const info = await NodeFSP.stat(destinationPath);
              const contentHash = await sha256File(destinationPath);
              return { byteLength: info.size, contentHash };
            },
            catch: mapFilesystemFailure,
          });
          if (
            copied.byteLength !== representation.byteLength ||
            copied.contentHash !== representation.contentHash
          ) {
            return yield* new AnalysisRunPromotionError({
              reason: "run-data-unavailable",
              message: `The local artifact '${representation.fileName}' no longer matches its run receipt. Run the file again before saving a project result.`,
            });
          }
          promotedRepresentations.set(`${artifact.artifactId}:${representation.representationId}`, {
            representationId: representation.representationId,
            fileName: representation.fileName,
            relativePath: `artifacts/${representation.fileName}`,
            mediaType: representation.mediaType,
            presentation: representation.presentation,
            requiresNetworkForFullExperience: representation.requiresNetworkForFullExperience,
            byteLength: copied.byteLength,
            contentHash: copied.contentHash,
          });
        }
      }

      const manifest = buildAnalysisRunCapsuleManifest({
        run: input.run,
        createdAt: input.createdAt,
        output: {
          relativePath: OUTPUT_FILE_NAME,
          byteLength: outputByteLength,
          contentHash: outputContentHash,
        },
        representations: promotedRepresentations,
      });
      const manifestJson = `${encodeUnknownJsonString(manifest)}\n`;
      const readme = renderAnalysisRunCapsuleReadme(manifest);
      const racedResult = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.writeFile(NodePath.join(stagingPath, MANIFEST_FILE_NAME), manifestJson, {
            encoding: "utf8",
            flag: "wx",
          });
          await NodeFSP.writeFile(NodePath.join(stagingPath, README_FILE_NAME), readme, {
            encoding: "utf8",
            flag: "wx",
          });
          try {
            await NodeFSP.rename(stagingPath, directoryPath);
            return null;
          } catch (cause) {
            const existingAfterRace = await existingCapsuleResult({
              directoryPath,
              directoryRelativePath,
              runId: input.run.receipt.runId,
              artifactFileCount,
            });
            if (existingAfterRace !== null) return existingAfterRace;
            throw cause;
          }
        },
        catch: mapFilesystemFailure,
      });
      if (racedResult !== null) return racedResult;
      return {
        directoryRelativePath,
        readmeRelativePath: `${directoryRelativePath}/${README_FILE_NAME}`,
        manifestRelativePath: `${directoryRelativePath}/${MANIFEST_FILE_NAME}`,
        artifactFileCount,
        reused: false,
      } satisfies AnalysisRunPromotionResult;
    });

    return yield* publish.pipe(
      Effect.catch((failure) =>
        Effect.tryPromise({
          try: () => NodeFSP.rm(stagingPath, { recursive: true, force: true }),
          catch: () => failure,
        }).pipe(Effect.andThen(Effect.fail(failure))),
      ),
    );
  });
}
