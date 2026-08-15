import {
  ArtifactAuthority,
  type ArtifactId,
  ArtifactRevisionId,
} from "@scientfactory/document-artifacts";
import type {
  ScientLatexForwardSyncRequest,
  ScientLatexForwardSyncResult,
  ScientLatexInverseSyncRequest,
  ScientLatexInverseSyncResult,
  ScientLatexSyncUnavailable,
  ScientLatexSyncUnavailableReason,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as GeneratedDocumentStore from "../documentArtifacts/GeneratedDocumentStore.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";
import { parseSyncTexForwardLocation, parseSyncTexInverseLocation } from "./syncTexOutput.ts";

const SyncTexNavigationMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workspaceRoot: Schema.String,
  rootRelativePath: Schema.String,
  compileDirectory: Schema.String,
  outputFileName: Schema.String,
  command: Schema.String,
  binDirectory: Schema.NullOr(Schema.String),
});
type SyncTexNavigationMetadata = typeof SyncTexNavigationMetadata.Type;
const SyncTexNavigationMetadataJson = Schema.fromJsonString(SyncTexNavigationMetadata);
const encodeNavigationMetadata = Schema.encodeSync(SyncTexNavigationMetadataJson);
const decodeNavigationMetadata = Schema.decodeUnknownOption(SyncTexNavigationMetadataJson);

interface PublishedSyncTexInput {
  readonly artifactId: ArtifactId;
  readonly revisionId: ArtifactRevisionId;
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  readonly compileDirectory: string;
  readonly syncTexPath: string;
  readonly toolchainExecutable: string;
  readonly managed: boolean;
}

const NAVIGATION_TIMEOUT = "10 seconds";
const NAVIGATION_MAX_OUTPUT_BYTES = 256 * 1024;

const unavailable = (
  reason: ScientLatexSyncUnavailableReason,
  message: string,
): ScientLatexSyncUnavailable => ({
  _tag: "unavailable",
  reason,
  message,
});

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export class LatexSyncTex extends Context.Service<
  LatexSyncTex,
  {
    readonly publishIndex: (
      input: PublishedSyncTexInput,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly forward: (
      input: ScientLatexForwardSyncRequest,
    ) => Effect.Effect<ScientLatexForwardSyncResult>;
    readonly inverse: (
      input: ScientLatexInverseSyncRequest,
    ) => Effect.Effect<ScientLatexInverseSyncResult>;
  }
>()("t3/scient/latex/LatexSyncTex") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const crypto = yield* Crypto.Crypto;
  const authority = ArtifactAuthority.make(yield* environment.getEnvironmentId);
  const pathDelimiter = hostPlatform === "win32" ? ";" : ":";

  const navigationDirectory = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
    path.join(config.latexDir, "synctex", artifactId, revisionId);

  const pathsEqual = (left: string, right: string): boolean => {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    return hostPlatform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  };

  /**
   * Auxiliary indexes follow the PDF store's retention without making the
   * build path re-read or hash old PDFs. A stat-only existence check is enough:
   * once the immutable revision disappears, its navigation index has no valid
   * request that can name it.
   */
  const sweepArtifactIndexes = (artifactId: ArtifactId, currentRevisionId: ArtifactRevisionId) =>
    Effect.gen(function* () {
      const artifactDirectory = path.join(config.latexDir, "synctex", artifactId);
      const revisions = yield* fileSystem
        .readDirectory(artifactDirectory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      yield* Effect.forEach(
        revisions.filter((revisionId) => revisionId !== currentRevisionId),
        (revisionId) =>
          store
            .revisionExists({
              authority,
              artifactId,
              revisionId: ArtifactRevisionId.make(revisionId),
            })
            .pipe(
              Effect.flatMap((exists) =>
                exists
                  ? Effect.void
                  : fileSystem.remove(path.join(artifactDirectory, revisionId), {
                      recursive: true,
                      force: true,
                    }),
              ),
              Effect.ignoreCause(),
            ),
        { discard: true },
      );
    }).pipe(Effect.ignoreCause());

  const publishIndex = (input: PublishedSyncTexInput) => {
    const finalDirectory = navigationDirectory(input.artifactId, input.revisionId);
    let temporaryDirectory: string | null = null;
    return Effect.gen(function* () {
      if (yield* fileSystem.exists(finalDirectory)) return;
      const stagingDirectory = `${finalDirectory}.tmp-${yield* crypto.randomUUIDv4}`;
      temporaryDirectory = stagingDirectory;
      const compressedPath = input.syncTexPath;
      const plainPath = compressedPath.replace(/\.gz$/iu, "");
      const sourcePath = (yield* fileSystem.exists(compressedPath))
        ? compressedPath
        : (yield* fileSystem.exists(plainPath))
          ? plainPath
          : null;
      // A compiler can exit cleanly without emitting an index. The PDF remains
      // valid; navigation is simply unavailable for this revision.
      if (sourcePath === null) return;

      const outputStem = path.basename(sourcePath).replace(/\.synctex(?:\.gz)?$/iu, "");
      const outputFileName = `${outputStem}.pdf`;
      const binDirectory = input.managed ? path.dirname(input.toolchainExecutable) : null;
      const command =
        binDirectory === null
          ? "synctex"
          : path.join(binDirectory, hostPlatform === "win32" ? "synctex.exe" : "synctex");
      const metadata: SyncTexNavigationMetadata = {
        schemaVersion: 1,
        workspaceRoot: input.workspaceRoot,
        rootRelativePath: normalizeRelativePath(input.rootRelativePath),
        compileDirectory: input.compileDirectory,
        outputFileName,
        command,
        binDirectory,
      };
      const indexFileName = `${outputStem}.synctex${sourcePath.endsWith(".gz") ? ".gz" : ""}`;
      const bytes = yield* fileSystem.readFile(sourcePath);
      yield* fileSystem.makeDirectory(path.dirname(finalDirectory), { recursive: true });
      yield* fileSystem.makeDirectory(stagingDirectory, { recursive: true });
      yield* fileSystem.writeFile(path.join(stagingDirectory, indexFileName), bytes);
      // The SyncTeX CLI requires `-o` to name an existing output. It finds the
      // separately retained index by this basename and never reads PDF bytes,
      // so a zero-byte marker satisfies the contract without duplicating every
      // immutable PDF revision into the navigation store.
      yield* fileSystem.writeFile(path.join(stagingDirectory, outputFileName), new Uint8Array());
      yield* fileSystem.writeFileString(
        path.join(stagingDirectory, "navigation.json"),
        `${encodeNavigationMetadata(metadata)}\n`,
      );
      yield* fileSystem.rename(stagingDirectory, finalDirectory);
      yield* sweepArtifactIndexes(input.artifactId, input.revisionId);
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          temporaryDirectory === null
            ? Effect.void
            : fileSystem
                .remove(temporaryDirectory, { recursive: true, force: true })
                .pipe(Effect.ignoreCause()),
        ),
      ),
    );
  };

  interface AvailableNavigation {
    readonly _tag: "available";
    readonly directory: string;
    readonly metadata: SyncTexNavigationMetadata;
    readonly outputPath: string;
  }

  const loadNavigation = (input: {
    readonly workspaceRoot: string;
    readonly rootRelativePath: string;
    readonly artifactId: ArtifactId;
    readonly revisionId: ArtifactRevisionId;
  }): Effect.Effect<AvailableNavigation | ScientLatexSyncUnavailable> =>
    Effect.gen(function* () {
      const revision = yield* store
        .resolveRevision({
          authority,
          artifactId: input.artifactId,
          revisionId: input.revisionId,
        })
        .pipe(Effect.option);
      if (Option.isNone(revision)) {
        yield* fileSystem
          .remove(navigationDirectory(input.artifactId, input.revisionId), {
            recursive: true,
            force: true,
          })
          .pipe(Effect.ignoreCause());
        return unavailable(
          "revision-unavailable",
          "This PDF revision is no longer available for source navigation.",
        );
      }

      const directory = navigationDirectory(input.artifactId, input.revisionId);
      const metadataText = yield* fileSystem
        .readFileString(path.join(directory, "navigation.json"))
        .pipe(Effect.option);
      if (Option.isNone(metadataText)) {
        return unavailable(
          "index-unavailable",
          "This PDF revision does not have a SyncTeX navigation index.",
        );
      }
      const decoded = decodeNavigationMetadata(metadataText.value);
      if (Option.isNone(decoded)) {
        return unavailable("index-unavailable", "The SyncTeX navigation index is unreadable.");
      }
      const metadata = decoded.value;
      if (
        !pathsEqual(metadata.workspaceRoot, input.workspaceRoot) ||
        metadata.rootRelativePath !== normalizeRelativePath(input.rootRelativePath)
      ) {
        return unavailable(
          "invalid-source",
          "The requested source does not belong to this PDF revision.",
        );
      }
      return {
        _tag: "available" as const,
        directory,
        metadata,
        outputPath: path.join(directory, metadata.outputFileName),
      };
    });

  const workspaceSource = (workspaceRoot: string, relativePath: string) => {
    if (path.isAbsolute(relativePath)) return null;
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relative = path.relative(path.resolve(workspaceRoot), absolutePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
    return { absolutePath, relativePath: normalizeRelativePath(relative) };
  };

  const runNavigation = (input: {
    readonly metadata: SyncTexNavigationMetadata;
    readonly directory: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    runner
      .run({
        command: input.metadata.command,
        args: input.args,
        cwd: input.metadata.compileDirectory,
        ...(input.metadata.binDirectory === null
          ? {}
          : {
              env: latexEngineEnvironment({
                base: {},
                hostEnvironment,
                binDirectory: input.metadata.binDirectory,
                pathDelimiter,
              }),
            }),
        timeout: NAVIGATION_TIMEOUT,
        maxOutputBytes: NAVIGATION_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);

  const forward = (
    input: ScientLatexForwardSyncRequest,
  ): Effect.Effect<ScientLatexForwardSyncResult> =>
    Effect.gen(function* () {
      const navigation = yield* loadNavigation(input);
      if (navigation._tag === "unavailable") return navigation;
      const source = workspaceSource(input.workspaceRoot, input.sourceRelativePath);
      if (source === null) {
        return unavailable("invalid-source", "The requested source path is outside the workspace.");
      }
      const position =
        input.pageHint === undefined
          ? `${input.line}:${input.column ?? 0}:${source.absolutePath}`
          : `${input.line}:${input.column ?? 0}:${input.pageHint}:${source.absolutePath}`;
      const result = yield* runNavigation({
        ...navigation,
        args: ["view", "-i", position, "-o", navigation.outputPath, "-d", navigation.directory],
      });
      if (Option.isNone(result)) {
        return unavailable("command-unavailable", "The SyncTeX command could not be started.");
      }
      if (result.value.timedOut || result.value.code !== 0) {
        return unavailable("not-found", "No PDF position matched this source line.");
      }
      const location = parseSyncTexForwardLocation(
        `${result.value.stdout}\n${result.value.stderr}`,
      );
      return location === null
        ? unavailable("not-found", "No PDF position matched this source line.")
        : ({ _tag: "found", ...location } satisfies ScientLatexForwardSyncResult);
    });

  const inverse = (
    input: ScientLatexInverseSyncRequest,
  ): Effect.Effect<ScientLatexInverseSyncResult> =>
    Effect.gen(function* () {
      const navigation = yield* loadNavigation(input);
      if (navigation._tag === "unavailable") return navigation;
      const result = yield* runNavigation({
        ...navigation,
        args: [
          "edit",
          "-o",
          `${input.page}:${input.x}:${input.y}:${navigation.outputPath}`,
          "-d",
          navigation.directory,
        ],
      });
      if (Option.isNone(result)) {
        return unavailable("command-unavailable", "The SyncTeX command could not be started.");
      }
      if (result.value.timedOut || result.value.code !== 0) {
        return unavailable("not-found", "No source line matched this PDF position.");
      }
      const location = parseSyncTexInverseLocation(
        `${result.value.stdout}\n${result.value.stderr}`,
      );
      if (location === null) {
        return unavailable("not-found", "No source line matched this PDF position.");
      }
      const absoluteInput = path.isAbsolute(location.input)
        ? path.resolve(location.input)
        : path.resolve(navigation.metadata.compileDirectory, location.input);
      const relative = path.relative(path.resolve(input.workspaceRoot), absoluteInput);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        return unavailable("invalid-source", "The matching source is outside the workspace.");
      }
      return {
        _tag: "found",
        relativePath: normalizeRelativePath(relative),
        line: location.line,
        column: location.column,
      } satisfies ScientLatexInverseSyncResult;
    });

  return LatexSyncTex.of({ publishIndex, forward, inverse });
});

export const layer = Layer.effect(LatexSyncTex, make).pipe(Layer.provide(ProcessRunner.layer));
