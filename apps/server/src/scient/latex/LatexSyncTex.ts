// @effect-diagnostics nodeBuiltinImport:off -- SyncTeX indexes are gzip files read once per build.
import * as NodeZlib from "node:zlib";

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
  ScientLatexPageAnchorsRequest,
  ScientLatexPageAnchorsResult,
  ScientLatexSyncUnavailable,
  ScientLatexSyncUnavailableReason,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
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
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import * as GeneratedDocumentStore from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as SyncTexRuntime from "./SyncTexRuntime.ts";
import { parseSyncTexForwardLocation, parseSyncTexInverseLocations } from "./syncTexOutput.ts";
import {
  collectLatexBuildEvidence,
  decodePublishedLatexBuildEvidence,
  latexEvidenceMatches,
  type PublishedLatexBuildEvidence,
} from "./latexBuildEvidence.ts";

const SyncTexNavigationMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  workspaceRoot: Schema.String,
  rootRelativePath: Schema.String,
  compileDirectory: Schema.String,
  outputFileName: Schema.String,
  evidenceFileName: Schema.String,
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
  readonly evidenceFileName: string;
}

const NAVIGATION_TIMEOUT = "10 seconds";
const NAVIGATION_MAX_OUTPUT_BYTES = 256 * 1024;
/** Where a page's first body line is asked for, in PDF points from the top left. */
const PAGE_ANCHOR_POINT = { x: 300, y: 110 } as const;
const PAGE_ANCHOR_CONCURRENCY = 4;
const PAGE_ANCHOR_MAX_PAGES = 2000;
/** A decompressed SyncTeX index larger than this is not read for page anchors. */
const PAGE_ANCHOR_MAX_INDEX_BYTES = 256 * 1024 * 1024;
const PAGE_ANCHOR_CACHE_SIZE = 16;
const PAGE_ANCHOR_MAX_SHEET_DIGITS = 12;
/** A whole batch ends within this, below the client's ten-minute deadline. */
const PAGE_ANCHOR_BUDGET = "8 minutes";

/** Bytes scanned between yields, so a long index never holds the server. */
const PAGE_ANCHOR_SCAN_CHUNK = 4 * 1024 * 1024;

/** Counts lines of the form `{<digits>` starting in `[from, to)`, without decoding. */
function countSheets(index: Uint8Array, from: number, to: number): number {
  let count = 0;
  for (let at = from; at < to; at++) {
    if (index[at] !== 0x7b || (at > 0 && index[at - 1] !== 0x0a)) continue;
    let end = at + 1;
    // A sheet number has at most a few digits; a malformed record never
    // carries the scan past its chunk.
    while (
      end < index.length &&
      end - at <= PAGE_ANCHOR_MAX_SHEET_DIGITS &&
      index[end]! >= 0x30 &&
      index[end]! <= 0x39
    )
      end++;
    if (end > at + 1 && (end === index.length || index[end] === 0x0a || index[end] === 0x0d))
      count++;
  }
  return count;
}

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
    readonly pageAnchors: (
      input: ScientLatexPageAnchorsRequest,
    ) => Effect.Effect<ScientLatexPageAnchorsResult>;
  }
>()("t3/scient/latex/LatexSyncTex") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const runtime = yield* SyncTexRuntime.SyncTexRuntime;
  const hostPlatform = yield* HostProcess.Platform;
  const crypto = yield* Crypto.Crypto;
  const workspaceFiles = yield* WorkspaceFileSystem;
  const authority = ArtifactAuthority.make(yield* environment.getEnvironmentId);

  const navigationDirectory = (artifactId: ArtifactId, revisionId: ArtifactRevisionId) =>
    path.join(config.latexDir, "synctex", artifactId, revisionId);

  const pathsEqual = (left: string, right: string): boolean => {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    return hostPlatform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  };

  const workspaceSource = (workspaceRoot: string, relativePath: string) => {
    if (path.isAbsolute(relativePath)) return null;
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relative = path.relative(path.resolve(workspaceRoot), absolutePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
    return { absolutePath, relativePath: normalizeRelativePath(relative) };
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
      const metadata: SyncTexNavigationMetadata = {
        schemaVersion: 4,
        workspaceRoot: input.workspaceRoot,
        rootRelativePath: normalizeRelativePath(input.rootRelativePath),
        compileDirectory: input.compileDirectory,
        outputFileName,
        evidenceFileName: input.evidenceFileName,
      };
      const indexFileName = `${outputStem}.synctex${sourcePath.endsWith(".gz") ? ".gz" : ""}`;
      yield* fileSystem.makeDirectory(path.dirname(finalDirectory), { recursive: true });
      yield* fileSystem.makeDirectory(stagingDirectory, { recursive: true });
      // Indexes can be large for long documents. Copy them directly into the
      // atomic staging directory instead of materializing the whole file in
      // the server heap.
      yield* fileSystem.copyFile(sourcePath, path.join(stagingDirectory, indexFileName));
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
    readonly receipt: PublishedLatexBuildEvidence;
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
          "index-missing",
          "This PDF revision does not have a SyncTeX navigation index.",
        );
      }
      const decoded = decodeNavigationMetadata(metadataText.value);
      if (Option.isNone(decoded)) {
        return unavailable(
          "index-invalid",
          "This PDF's source-navigation index is unreadable. Rebuild the document.",
        );
      }
      const metadata = decoded.value;
      const metadataRoot = workspaceSource(input.workspaceRoot, metadata.rootRelativePath);
      if (
        !pathsEqual(metadata.workspaceRoot, input.workspaceRoot) ||
        metadata.rootRelativePath !== normalizeRelativePath(input.rootRelativePath) ||
        metadataRoot === null ||
        !pathsEqual(metadata.compileDirectory, path.dirname(metadataRoot.absolutePath)) ||
        path.basename(metadata.outputFileName) !== metadata.outputFileName ||
        !metadata.outputFileName.toLowerCase().endsWith(".pdf") ||
        path.basename(metadata.evidenceFileName) !== metadata.evidenceFileName
      ) {
        return unavailable(
          "invalid-source",
          "The requested source does not belong to this PDF revision.",
        );
      }
      const receiptText = yield* fileSystem
        .readFileString(path.join(config.latexDir, "evidence", metadata.evidenceFileName))
        .pipe(Effect.orElseSucceed(() => null));
      const receipt = receiptText === null ? null : decodePublishedLatexBuildEvidence(receiptText);
      if (
        receipt === null ||
        receipt.artifactId !== input.artifactId ||
        receipt.revisionId !== input.revisionId ||
        receipt.evidence.rootRelativePath !== metadata.rootRelativePath ||
        receipt.sourceRevisions === undefined ||
        receipt.mutationEpoch === undefined ||
        receipt.evidence.truncated
      ) {
        return unavailable(
          "source-stale",
          "This PDF has no proven compiled source revision. Rebuild the document.",
        );
      }
      const current = yield* validateSources(input.workspaceRoot, receipt);
      if (current !== null) return current;
      return {
        _tag: "available" as const,
        directory,
        metadata,
        outputPath: path.join(directory, metadata.outputFileName),
        receipt,
      };
    });

  const validateSources = Effect.fnUntraced(
    function* (workspaceRoot: string, receipt: PublishedLatexBuildEvidence) {
      const stale = unavailable(
        "source-stale",
        "The source changed since this PDF was compiled. Rebuild the document.",
      );
      if (
        (yield* workspaceFiles.getMutationEpoch({ cwd: workspaceRoot })) !== receipt.mutationEpoch
      )
        return stale;
      if (
        receipt.evidence.dependencies.some(
          (dependency) => workspaceSource(workspaceRoot, dependency.path) === null,
        )
      )
        return stale;
      for (const [relativePath, revision] of Object.entries(receipt.sourceRevisions ?? {})) {
        if (workspaceSource(workspaceRoot, relativePath) === null) return stale;
        const source = yield* workspaceFiles
          .readFile({ cwd: workspaceRoot, relativePath })
          .pipe(Effect.option);
        if (
          Option.isNone(source) ||
          source.value.truncated ||
          source.value.publicationAttention !== undefined ||
          source.value.revision !== revision
        )
          return stale;
      }
      const current = yield* collectLatexBuildEvidence({
        workspaceRoot,
        rootRelativePath: receipt.evidence.rootRelativePath,
        dependencies: receipt.evidence.dependencies.map((dependency) => dependency.path),
        truncated: receipt.evidence.truncated,
        nowEpochMs: receipt.evidence.recordedAtEpochMs,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      return !latexEvidenceMatches(receipt.evidence, current.evidence) ||
        (yield* workspaceFiles.getMutationEpoch({ cwd: workspaceRoot })) !== receipt.mutationEpoch
        ? stale
        : null;
    },
    Effect.catch(() =>
      Effect.succeed(
        unavailable(
          "source-stale",
          "The current source publication could not be verified. Resolve file recovery and rebuild the document.",
        ),
      ),
    ),
  );

  const runNavigation = (input: {
    readonly metadata: SyncTexNavigationMetadata;
    readonly directory: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    runner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.metadata.compileDirectory,
        timeout: NAVIGATION_TIMEOUT,
        maxOutputBytes: NAVIGATION_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);

  const resolveNavigator = runtime.resolve.pipe(
    Effect.map((resolved) => ({ _tag: "available" as const, command: resolved.command })),
    Effect.catch((error) =>
      Effect.succeed(
        unavailable(
          "navigator-unavailable",
          `${error.detail} Repair or reinstall Scient to restore source navigation.`,
        ),
      ),
    ),
  );

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
      if (navigation.receipt.sourceRevisions?.[source.relativePath] !== input.sourceRevision)
        return unavailable(
          "source-stale",
          "This source position does not belong to the compiled revision.",
        );
      const resolvedRuntime = yield* resolveNavigator;
      if (resolvedRuntime._tag === "unavailable") return resolvedRuntime;
      const beforeQuery = yield* validateSources(input.workspaceRoot, navigation.receipt);
      if (beforeQuery !== null) return beforeQuery;
      const position =
        input.pageHint === undefined
          ? `${input.line}:${input.column ?? 0}:${source.absolutePath}`
          : `${input.line}:${input.column ?? 0}:${input.pageHint}:${source.absolutePath}`;
      const result = yield* runNavigation({
        ...navigation,
        command: resolvedRuntime.command,
        args: ["view", "-i", position, "-o", navigation.outputPath, "-d", navigation.directory],
      });
      if (Option.isNone(result)) {
        return unavailable(
          "navigator-failed",
          "Scient's source-navigation helper could not be started.",
        );
      }
      if (result.value.timedOut)
        return unavailable("query-timed-out", "Source navigation took too long. Try again.");
      if (result.value.code !== 0)
        return unavailable("navigator-failed", "Source navigation could not be completed.");
      let location = parseSyncTexForwardLocation(`${result.value.stdout}\n${result.value.stderr}`);
      // Engines can record canonical paths (notably /private/var on macOS)
      // while the workspace is opened through a symlink. Keep the logical
      // workspace identity, but retry that same source's physical spelling.
      if (location === null) {
        const canonicalRoot = yield* fileSystem
          .realPath(input.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => input.workspaceRoot));
        const canonicalSource = yield* fileSystem
          .realPath(source.absolutePath)
          .pipe(Effect.orElseSucceed(() => source.absolutePath));
        const relative = path.relative(canonicalRoot, canonicalSource);
        if (
          canonicalSource !== source.absolutePath &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        ) {
          const canonicalPosition =
            input.pageHint === undefined
              ? `${input.line}:${input.column ?? 0}:${canonicalSource}`
              : `${input.line}:${input.column ?? 0}:${input.pageHint}:${canonicalSource}`;
          const retry = yield* runNavigation({
            ...navigation,
            command: resolvedRuntime.command,
            args: [
              "view",
              "-i",
              canonicalPosition,
              "-o",
              navigation.outputPath,
              "-d",
              navigation.directory,
            ],
          });
          if (Option.isSome(retry) && retry.value.code === 0 && !retry.value.timedOut)
            location = parseSyncTexForwardLocation(`${retry.value.stdout}\n${retry.value.stderr}`);
        }
      }
      const current = yield* loadNavigation(input);
      if (current._tag === "unavailable") return current;
      return location === null
        ? unavailable("position-unmapped", "No PDF position is mapped to this source line.")
        : ({
            _tag: "found",
            page: location.page,
            x: location.x,
            y: location.y,
          } satisfies ScientLatexForwardSyncResult);
    });

  const inverse = (
    input: ScientLatexInverseSyncRequest,
  ): Effect.Effect<ScientLatexInverseSyncResult> =>
    Effect.gen(function* () {
      const navigation = yield* loadNavigation(input);
      if (navigation._tag === "unavailable") return navigation;
      const resolvedRuntime = yield* resolveNavigator;
      if (resolvedRuntime._tag === "unavailable") return resolvedRuntime;
      const beforeQuery = yield* validateSources(input.workspaceRoot, navigation.receipt);
      if (beforeQuery !== null) return beforeQuery;
      const result = yield* runNavigation({
        ...navigation,
        command: resolvedRuntime.command,
        args: [
          "edit",
          "-o",
          `${input.page}:${input.x}:${input.y}:${navigation.outputPath}`,
          "-d",
          navigation.directory,
        ],
      });
      if (Option.isNone(result)) {
        return unavailable(
          "navigator-failed",
          "Scient's source-navigation helper could not be started.",
        );
      }
      if (result.value.timedOut)
        return unavailable("query-timed-out", "Source navigation took too long. Try again.");
      if (result.value.code !== 0)
        return unavailable("navigator-failed", "Source navigation could not be completed.");
      const locations = parseSyncTexInverseLocations(
        `${result.value.stdout}\n${result.value.stderr}`,
      );
      if (locations.length === 0) {
        return unavailable("position-unmapped", "No source line is mapped to this PDF position.");
      }
      const canonicalWorkspace = yield* fileSystem
        .realPath(input.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => path.resolve(input.workspaceRoot)));
      for (const location of locations) {
        const absoluteInput = path.isAbsolute(location.input)
          ? path.resolve(location.input)
          : path.resolve(navigation.metadata.compileDirectory, location.input);
        const canonicalInput = yield* fileSystem
          .realPath(absoluteInput)
          .pipe(Effect.orElseSucceed(() => absoluteInput));
        const relative = path.relative(canonicalWorkspace, canonicalInput);
        if (
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          continue;
        const relativePath = normalizeRelativePath(relative);
        const sourceRevision = navigation.receipt.sourceRevisions?.[relativePath];
        if (sourceRevision === undefined)
          return unavailable(
            "source-stale",
            "The matching source has no proven compiled revision. Rebuild the document.",
          );
        const current = yield* loadNavigation(input);
        if (current._tag === "unavailable") return current;
        return {
          _tag: "found",
          relativePath,
          sourceRevision,
          line: location.line,
          column: location.column,
        } satisfies ScientLatexInverseSyncResult;
      }
      if (locations.length > 0) {
        return unavailable("invalid-source", "The matching source is outside the workspace.");
      }
      return unavailable("position-unmapped", "No source line is mapped to this PDF position.");
    });

  /** One sheet record (`{n` at the start of a line) per page of the compiled output. */
  const indexPageCount = (navigation: AvailableNavigation) =>
    Effect.gen(function* () {
      const stem = navigation.metadata.outputFileName.replace(/\.pdf$/iu, "");
      for (const name of [`${stem}.synctex.gz`, `${stem}.synctex`]) {
        const file = path.join(navigation.directory, name);
        const info = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        // Either form is bounded before it is read.
        if (Number(info.value.size) > PAGE_ANCHOR_MAX_INDEX_BYTES) return 0;
        const bytes = yield* fileSystem.readFile(file).pipe(Effect.option);
        if (Option.isNone(bytes)) continue;
        // Decompressed off the event loop, with a bound on its size.
        const index = name.endsWith(".gz")
          ? yield* Effect.tryPromise(
              () =>
                new Promise<Uint8Array>((resolve, reject) =>
                  NodeZlib.gunzip(
                    bytes.value,
                    { maxOutputLength: PAGE_ANCHOR_MAX_INDEX_BYTES },
                    (error, result) => (error ? reject(error) : resolve(result)),
                  ),
                ),
            ).pipe(Effect.option)
          : Option.some(bytes.value);
        if (Option.isNone(index)) return 0;
        let count = 0;
        for (let from = 0; from < index.value.length; from += PAGE_ANCHOR_SCAN_CHUNK) {
          count += countSheets(
            index.value,
            from,
            Math.min(index.value.length, from + PAGE_ANCHOR_SCAN_CHUNK),
          );
          yield* Effect.yieldNow;
        }
        return count;
      }
      return 0;
    });

  // Anchors of a build never change; requests repeat when the editor reopens.
  const anchorCache = new Map<string, ScientLatexPageAnchorsResult>();
  // One batch per build at a time; every request for it awaits the same answer.
  const anchorBatches = new Map<string, Deferred.Deferred<ScientLatexPageAnchorsResult>>();

  /** Queries every page of a build whose sources were just validated. */
  const queryPageAnchors = (
    input: ScientLatexPageAnchorsRequest,
    navigation: AvailableNavigation,
  ): Effect.Effect<ScientLatexPageAnchorsResult> =>
    Effect.gen(function* () {
      const resolvedRuntime = yield* resolveNavigator;
      if (resolvedRuntime._tag === "unavailable") return resolvedRuntime;
      const pageCount = yield* indexPageCount(navigation);
      if (pageCount === 0)
        return unavailable("index-invalid", "This PDF's navigation index has no pages.");
      const canonicalWorkspace = yield* fileSystem
        .realPath(input.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => path.resolve(input.workspaceRoot)));
      const revisions = navigation.receipt.sourceRevisions ?? {};
      // Every page counts; only the first pages are located.
      const pages = Array.from(
        { length: Math.min(pageCount, PAGE_ANCHOR_MAX_PAGES) },
        (_, index) => index + 1,
      );
      const results = yield* Effect.forEach(
        pages,
        (page) =>
          Effect.gen(function* () {
            const result = yield* runNavigation({
              ...navigation,
              command: resolvedRuntime.command,
              args: [
                "edit",
                "-o",
                `${page}:${PAGE_ANCHOR_POINT.x}:${PAGE_ANCHOR_POINT.y}:${navigation.outputPath}`,
                "-d",
                navigation.directory,
              ],
            });
            if (Option.isNone(result) || result.value.timedOut || result.value.code !== 0)
              return "failed" as const;
            for (const location of parseSyncTexInverseLocations(
              `${result.value.stdout}\n${result.value.stderr}`,
            )) {
              const absoluteInput = path.isAbsolute(location.input)
                ? path.resolve(location.input)
                : path.resolve(navigation.metadata.compileDirectory, location.input);
              const canonicalInput = yield* fileSystem
                .realPath(absoluteInput)
                .pipe(Effect.orElseSucceed(() => absoluteInput));
              const relativePath = normalizeRelativePath(
                path.relative(canonicalWorkspace, canonicalInput),
              );
              if (revisions[relativePath] === undefined) return null;
              return { page, relativePath, line: location.line, column: location.column };
            }
            return null;
          }),
        { concurrency: PAGE_ANCHOR_CONCURRENCY },
      );
      if (results.includes("failed"))
        return unavailable("navigator-failed", "Page positions could not be read from this PDF.");
      return {
        _tag: "found",
        pageCount,
        anchors: results.filter((anchor) => anchor !== null && anchor !== "failed"),
        sourceRevisions: revisions,
      } satisfies ScientLatexPageAnchorsResult;
    });

  /**
   * Where each page of this build begins: the source file and line SyncTeX
   * maps near the top of each page's text, for every workspace source the
   * build compiled. Pages beginning with material from outside the workspace
   * are omitted. Navigation hints for Visual, not a reproduction of TeX's page
   * breaking.
   *
   * The batch runs once per build, detached from the requests that wait for
   * it: a request that goes away does not cancel the others, and the answer is
   * kept for the next one. It is bounded by an overall budget.
   */
  const pageAnchors = (
    input: ScientLatexPageAnchorsRequest,
  ): Effect.Effect<ScientLatexPageAnchorsResult> =>
    Effect.gen(function* () {
      const navigation = yield* loadNavigation(input);
      if (navigation._tag === "unavailable") return navigation;
      const beforeQuery = yield* validateSources(input.workspaceRoot, navigation.receipt);
      if (beforeQuery !== null) return beforeQuery;
      const key = [input.workspaceRoot, input.artifactId, input.revisionId].join("\u0000");
      const cached = anchorCache.get(key);
      if (cached) return cached;
      let batch = anchorBatches.get(key);
      if (!batch) {
        const started = yield* Deferred.make<ScientLatexPageAnchorsResult>();
        batch = started;
        anchorBatches.set(key, started);
        yield* queryPageAnchors(input, navigation).pipe(
          Effect.timeoutOption(PAGE_ANCHOR_BUDGET),
          Effect.map(
            Option.getOrElse(() =>
              unavailable("query-timed-out", "Reading this PDF's pages took too long."),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result._tag !== "found") return;
              anchorCache.delete(key);
              anchorCache.set(key, result);
              if (anchorCache.size > PAGE_ANCHOR_CACHE_SIZE)
                anchorCache.delete(anchorCache.keys().next().value!);
            }),
          ),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(started, exit)),
          Effect.ensuring(Effect.sync(() => anchorBatches.delete(key))),
          Effect.forkDetach,
        );
      }
      const result = yield* Deferred.await(batch);
      if (result._tag !== "found") return result;
      // The build may have been replaced while its pages were read.
      const current = yield* loadNavigation(input);
      return current._tag === "unavailable" ? current : result;
    });

  return LatexSyncTex.of({ publishIndex, forward, inverse, pageAnchors });
});

export const layer = Layer.effect(LatexSyncTex, make).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(SyncTexRuntime.layer),
);
