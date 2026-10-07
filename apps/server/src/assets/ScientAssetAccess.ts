/**
 * Scient's asset kinds in AssetAccess: issuing signed claims for generated
 * documents, analysis artifacts, compute outputs and environment files, and
 * resolving those claims back to the one file each grants.
 */
import {
  AssetAnalysisArtifactNotFoundError,
  AssetComputeOutputNotFoundError,
  AssetEnvironmentFileInspectionError,
  AssetEnvironmentFileNotFoundError,
  AssetEnvironmentFilePathValidationError,
  AssetGeneratedDocumentAuthorityMismatchError,
  AssetGeneratedDocumentNotFoundError,
  type AssetResource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import type { ResolvedAnalysisArtifactRepresentation } from "../scient/analysis/LocalAnalysisStore.ts";
import type { ResolvedComputeOutputResource } from "../scient/compute/LocalComputeStore.ts";
import type { ResolvedGeneratedDocumentRevision } from "../scient/documentArtifacts/GeneratedDocumentStore.ts";
import { decodeRelativePath, optionOnNotFound, type ResolvedAsset } from "./AssetAccess.ts";
import type { ScientAssetClaims } from "./ScientAssetClaims.ts";

const ENVIRONMENT_HTML_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ENVIRONMENT_HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

const SCIENT_ASSET_CLAIM_KINDS: ReadonlySet<string> = new Set<ScientAssetClaims["kind"]>([
  "generated-document",
  "analysis-artifact",
  "compute-output",
  "environment-file-exact",
  "environment-html-document",
]);

export const isScientAssetClaims = (claims: {
  readonly kind: string;
}): claims is ScientAssetClaims => SCIENT_ASSET_CLAIM_KINDS.has(claims.kind);

const resolveCanonicalEnvironmentDocumentFileForRequest = (input: {
  readonly baseDirectory: string;
  readonly relativePath: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalCandidate = yield* optionOnNotFound(
      fileSystem.realPath(path.join(input.baseDirectory, input.relativePath)),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to resolve environment HTML asset.", {
          baseDirectory: input.baseDirectory,
          relativePath: input.relativePath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(canonicalCandidate)) return null;
    const relative = path.relative(input.baseDirectory, canonicalCandidate.value);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    const info = yield* optionOnNotFound(fileSystem.stat(canonicalCandidate.value)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File" ? canonicalCandidate.value : null;
  });

const resolveCanonicalEnvironmentFileForRequest = (canonicalPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const resolved = yield* optionOnNotFound(fileSystem.realPath(canonicalPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to resolve exact environment asset.", {
          canonicalPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(resolved) || resolved.value !== canonicalPath) return null;
    const info = yield* optionOnNotFound(fileSystem.stat(resolved.value)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File" ? resolved.value : null;
  });

/** The issueAssetUrl inputs Scient's asset kinds read. */
export interface ScientAssetIssueInput {
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "generated-document"
        | "analysis-artifact"
        | "compute-output"
        | "environment-file";
    }
  >;
  readonly expiresInMs?: number;
  readonly generatedDocument?: ResolvedGeneratedDocumentRevision;
  readonly generatedDocumentExpiresAtEpochMs?: number;
  readonly analysisArtifact?: ResolvedAnalysisArtifactRepresentation;
  readonly computeOutput?: ResolvedComputeOutputResource;
}

/** Builds the claims, file name, source path and expiry that issueAssetUrl signs. */
export const issueScientAssetClaims = Effect.fnUntraced(function* (
  input: ScientAssetIssueInput,
  issue: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly issuedAt: number;
    readonly expiresAt: number;
  },
) {
  const { fileSystem, path, issuedAt } = issue;
  let expiresAt = issue.expiresAt;
  let claims: ScientAssetClaims;
  let fileName: string;
  let sourcePath: string | undefined;

  switch (input.resource._tag) {
    case "generated-document": {
      if (!input.generatedDocument) {
        return yield* new AssetGeneratedDocumentNotFoundError({ resource: input.resource });
      }
      if (input.generatedDocument.artifact.authority !== input.resource.authority) {
        return yield* new AssetGeneratedDocumentAuthorityMismatchError({
          resource: input.resource,
        });
      }
      if (
        input.generatedDocument.artifact.artifactId !== input.resource.artifactId ||
        input.generatedDocument.artifact.revisionId !== input.resource.revisionId
      ) {
        return yield* new AssetGeneratedDocumentNotFoundError({ resource: input.resource });
      }
      if (input.generatedDocumentExpiresAtEpochMs !== undefined) {
        expiresAt = input.generatedDocumentExpiresAtEpochMs;
      }
      const config = yield* ServerConfig.ServerConfig;
      const [canonicalArtifactsRoot, canonicalGeneratedPath] = yield* Effect.all([
        fileSystem.realPath(config.documentArtifactsDir),
        fileSystem.realPath(input.generatedDocument.path),
      ]).pipe(
        Effect.mapError(
          () => new AssetGeneratedDocumentNotFoundError({ resource: input.resource }),
        ),
      );
      const generatedRelativePath = path.relative(canonicalArtifactsRoot, canonicalGeneratedPath);
      if (
        generatedRelativePath === "" ||
        generatedRelativePath.startsWith("..") ||
        path.isAbsolute(generatedRelativePath)
      ) {
        return yield* new AssetGeneratedDocumentNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "generated-document",
        authority: input.generatedDocument.artifact.authority,
        artifactId: input.generatedDocument.artifact.artifactId,
        revisionId: input.generatedDocument.artifact.revisionId,
        path: canonicalGeneratedPath,
        fileName: input.generatedDocument.fileName,
        expiresAt,
        revisionSize: input.generatedDocument.revision.size,
        revisionMtimeMs: input.generatedDocument.revision.mtimeMs,
      };
      fileName = input.generatedDocument.fileName;
      break;
    }
    case "analysis-artifact": {
      const resolved = input.analysisArtifact;
      if (
        !resolved ||
        resolved.artifact.artifactId !== input.resource.artifactId ||
        resolved.representation.representationId !== input.resource.representationId
      ) {
        return yield* new AssetAnalysisArtifactNotFoundError({ resource: input.resource });
      }
      const config = yield* ServerConfig.ServerConfig;
      const [canonicalAnalysisRoot, canonicalArtifactPath] = yield* Effect.all([
        fileSystem.realPath(config.analysisDir),
        fileSystem.realPath(resolved.path),
      ]).pipe(
        Effect.mapError(() => new AssetAnalysisArtifactNotFoundError({ resource: input.resource })),
      );
      const analysisRelativePath = path.relative(canonicalAnalysisRoot, canonicalArtifactPath);
      if (
        analysisRelativePath === "" ||
        analysisRelativePath.startsWith("..") ||
        path.isAbsolute(analysisRelativePath)
      ) {
        return yield* new AssetAnalysisArtifactNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "analysis-artifact",
        projectId: input.resource.projectId,
        runId: input.resource.runId,
        artifactId: input.resource.artifactId,
        representationId: input.resource.representationId,
        path: canonicalArtifactPath,
        fileName: resolved.representation.fileName,
        expiresAt,
        revisionSize: resolved.revision.size,
        revisionMtimeMs: resolved.revision.mtimeMs,
      };
      fileName = resolved.representation.fileName;
      break;
    }
    case "compute-output": {
      const resolved = input.computeOutput;
      // The hash is the identity, so a resolution for a different resource is
      // not a near miss to be tolerated: it is the wrong retained output.
      if (!resolved || resolved.contentHash !== input.resource.contentHash) {
        return yield* new AssetComputeOutputNotFoundError({ resource: input.resource });
      }
      const config = yield* ServerConfig.ServerConfig;
      const [canonicalComputeRoot, canonicalOutputPath] = yield* Effect.all([
        fileSystem.realPath(config.computeDir),
        fileSystem.realPath(resolved.path),
      ]).pipe(
        Effect.mapError(() => new AssetComputeOutputNotFoundError({ resource: input.resource })),
      );
      // Re-established here rather than trusted from the store. This is the
      // last place a path becomes a signed URL, so containment is checked where
      // the consequence is, not only where the path was produced.
      const computeRelativePath = path.relative(canonicalComputeRoot, canonicalOutputPath);
      if (
        computeRelativePath === "" ||
        computeRelativePath.startsWith("..") ||
        path.isAbsolute(computeRelativePath)
      ) {
        return yield* new AssetComputeOutputNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "compute-output",
        projectId: input.resource.projectId,
        sessionId: input.resource.sessionId,
        executionId: input.resource.executionId,
        contentHash: input.resource.contentHash,
        path: canonicalOutputPath,
        fileName: resolved.fileName,
        expiresAt,
        revisionSize: resolved.revision.size,
        revisionMtimeMs: resolved.revision.mtimeMs,
      };
      fileName = resolved.fileName;
      break;
    }
    case "environment-file": {
      if (!path.isAbsolute(input.resource.path)) {
        return yield* new AssetEnvironmentFilePathValidationError({
          resource: input.resource,
        });
      }
      const canonicalFile = yield* optionOnNotFound(fileSystem.realPath(input.resource.path)).pipe(
        Effect.mapError(
          (cause) =>
            new AssetEnvironmentFileInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (Option.isNone(canonicalFile)) {
        return yield* new AssetEnvironmentFileNotFoundError({ resource: input.resource });
      }
      const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value)).pipe(
        Effect.mapError(
          (cause) =>
            new AssetEnvironmentFileInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (Option.isNone(info) || info.value.type !== "File") {
        return yield* new AssetEnvironmentFileNotFoundError({ resource: input.resource });
      }
      fileName = path.basename(canonicalFile.value);
      sourcePath = canonicalFile.value;
      if (input.resource.access === "html-document") {
        if (!ENVIRONMENT_HTML_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
          return yield* new AssetEnvironmentFilePathValidationError({
            resource: input.resource,
          });
        }
        // Browser tabs cannot replace an expired document token without
        // reloading and losing interactive state. Keep one normal workday plus
        // restart headroom while exact file capabilities retain the short TTL.
        if (input.expiresInMs === undefined) expiresAt = issuedAt + ENVIRONMENT_HTML_TOKEN_TTL_MS;
        claims = {
          version: 1,
          kind: "environment-html-document",
          baseDirectory: path.dirname(canonicalFile.value),
          entryFileName: fileName,
          expiresAt,
        };
      } else {
        claims = {
          version: 1,
          kind: "environment-file-exact",
          path: canonicalFile.value,
          fileName,
          expiresAt,
          revisionSize: Number(info.value.size),
          revisionMtimeMs: Option.match(info.value.mtime, {
            onNone: () => null,
            onSome: (mtime) => mtime.getTime(),
          }),
        };
      }
      break;
    }
  }
  return { claims, fileName, sourcePath, expiresAt };
});

/** Resolves a Scient claim to the file it grants, or null when the request does not match. */
export const resolveScientAsset = Effect.fnUntraced(function* (
  claims: ScientAssetClaims,
  relativePath: string,
) {
  if (claims.kind === "generated-document") {
    const decodedPath = decodeRelativePath(relativePath);
    if (decodedPath === null || decodedPath !== claims.fileName) return null;
    return {
      kind: "file",
      path: claims.path,
      revision: {
        size: claims.revisionSize,
        mtimeMs: claims.revisionMtimeMs,
      },
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "analysis-artifact") {
    const decodedPath = decodeRelativePath(relativePath);
    if (decodedPath === null || decodedPath !== claims.fileName) return null;
    return {
      kind: "file",
      path: claims.path,
      revision: {
        size: claims.revisionSize,
        mtimeMs: claims.revisionMtimeMs,
      },
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "compute-output") {
    const decodedPath = decodeRelativePath(relativePath);
    if (decodedPath === null || decodedPath !== claims.fileName) return null;
    return {
      kind: "file",
      path: claims.path,
      revision: {
        size: claims.revisionSize,
        mtimeMs: claims.revisionMtimeMs,
      },
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "environment-file-exact") {
    const decodedPath = decodeRelativePath(relativePath);
    if (decodedPath === null || decodedPath !== claims.fileName) return null;
    const canonicalFile = yield* resolveCanonicalEnvironmentFileForRequest(claims.path);
    if (canonicalFile === null) return null;
    return {
      kind: "file",
      path: canonicalFile,
      revision: {
        size: claims.revisionSize,
        mtimeMs: claims.revisionMtimeMs,
      },
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "environment-html-document") {
    const decodedPath = decodeRelativePath(relativePath);
    if (decodedPath === null) return null;
    const path = yield* Path.Path;
    const segments = decodedPath.split(/[\\/]/u);
    if (
      decodedPath.length === 0 ||
      decodedPath.includes("\0") ||
      path.isAbsolute(decodedPath) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      (decodedPath !== claims.entryFileName && segments.some((segment) => segment.startsWith(".")))
    ) {
      return null;
    }
    const documentFile = yield* resolveCanonicalEnvironmentDocumentFileForRequest({
      baseDirectory: claims.baseDirectory,
      relativePath: decodedPath,
    });
    return documentFile
      ? ({ kind: "file", path: documentFile, cacheControl: "no-store" } satisfies ResolvedAsset)
      : null;
  }
  return null;
});
