// @effect-diagnostics nodeBuiltinImport:off -- append-only run journals are a Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";

import {
  AnalysisRunSnapshot,
  type AnalysisRunSnapshot as AnalysisRunSnapshotType,
} from "@scientfactory/analysis";
import {
  ExecutionOutputChunk,
  type ExecutionOutputChunk as OutputChunk,
} from "@scientfactory/execution";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";

const MetadataJson = Schema.fromJsonString(AnalysisRunSnapshot);
const OutputJson = Schema.fromJsonString(ExecutionOutputChunk);
const RuntimeSettingsJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    executablePaths: Schema.Record(Schema.String, Schema.String),
  }),
);
const decodeMetadata = Schema.decodeUnknownOption(MetadataJson);
const encodeMetadata = Schema.encodeEffect(MetadataJson);
const decodeOutput = Schema.decodeUnknownOption(OutputJson);
const encodeOutput = Schema.encodeEffect(OutputJson);
const decodeRuntimeSettings = Schema.decodeUnknownOption(RuntimeSettingsJson);
const encodeRuntimeSettings = Schema.encodeEffect(RuntimeSettingsJson);

export class LocalAnalysisStoreError extends Schema.TaggedErrorClass<LocalAnalysisStoreError>()(
  "LocalAnalysisStoreError",
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalAnalysisStore extends Context.Service<
  LocalAnalysisStore,
  {
    readonly readRuntimeExecutablePath: (
      runtimeKind: string,
    ) => Effect.Effect<string | null, LocalAnalysisStoreError>;
    readonly writeRuntimeExecutablePath: (
      runtimeKind: string,
      executablePath: string | null,
    ) => Effect.Effect<void, LocalAnalysisStoreError>;
    readonly persistRun: (
      run: AnalysisRunSnapshotType,
    ) => Effect.Effect<void, LocalAnalysisStoreError>;
    readonly appendOutput: (
      projectId: string,
      runId: string,
      chunk: OutputChunk,
    ) => Effect.Effect<void, LocalAnalysisStoreError>;
    readonly loadRuns: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<AnalysisRunSnapshotType>, LocalAnalysisStoreError>;
    readonly loadRun: (
      projectId: string,
      runId: string,
    ) => Effect.Effect<AnalysisRunSnapshotType | null, LocalAnalysisStoreError>;
  }
>()("t3/scient/analysis/LocalAnalysisStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeLock = yield* Semaphore.make(1);
  const root = config.analysisDir;
  const runsRoot = path.join(root, "runs");
  const runtimeSettingsPath = path.join(root, "runtime-settings.json");

  const storeError = (operation: string, operationPath: string, cause: unknown) =>
    new LocalAnalysisStoreError({ operation, path: operationPath, cause });

  const mapStoreError =
    (operation: string, operationPath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LocalAnalysisStoreError, R> =>
      Effect.mapError(effect, (cause) => storeError(operation, operationPath, cause));

  const atomicWrite = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      mapStoreError("atomic-write", filePath),
    );

  const readRuntimeSettings = Effect.gen(function* () {
    if (
      !(yield* fs.exists(runtimeSettingsPath).pipe(mapStoreError("exists", runtimeSettingsPath)))
    ) {
      return { version: 1 as const, executablePaths: {} };
    }
    const contents = yield* fs
      .readFileString(runtimeSettingsPath)
      .pipe(mapStoreError("read-runtime-settings", runtimeSettingsPath));
    const settings = decodeRuntimeSettings(contents);
    if (settings._tag === "None") {
      return yield* new LocalAnalysisStoreError({
        operation: "decode-runtime-settings",
        path: runtimeSettingsPath,
        cause: new Error("Invalid analysis runtime settings."),
      });
    }
    return settings.value;
  });

  const readRuntimeExecutablePath = (runtimeKind: string) =>
    Effect.map(readRuntimeSettings, (settings) => settings.executablePaths[runtimeKind] ?? null);

  const writeRuntimeExecutablePath = (runtimeKind: string, executablePath: string | null) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* readRuntimeSettings;
        const executablePaths = { ...settings.executablePaths };
        if (executablePath === null) delete executablePaths[runtimeKind];
        else executablePaths[runtimeKind] = executablePath;
        const contents = yield* encodeRuntimeSettings({
          version: 1,
          executablePaths,
        }).pipe(mapStoreError("encode-runtime-settings", runtimeSettingsPath));
        yield* atomicWrite(runtimeSettingsPath, contents);
      }),
    );

  const runDirectory = (projectId: string, runId: string) => path.join(runsRoot, projectId, runId);

  const persistRun = (run: AnalysisRunSnapshotType) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = runDirectory(run.projectId, run.receipt.runId);
        const metadataPath = path.join(directory, "run.json");
        const metadata = {
          ...run,
          receipt: { ...run.receipt, output: [] },
        } satisfies AnalysisRunSnapshotType;
        const contents = yield* encodeMetadata(metadata).pipe(
          mapStoreError("encode-run", metadataPath),
        );
        yield* atomicWrite(metadataPath, contents);
      }),
    );

  const appendOutput = (projectId: string, runId: string, chunk: OutputChunk) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const outputPath = path.join(runDirectory(projectId, runId), "output.ndjson");
        yield* fs
          .makeDirectory(path.dirname(outputPath), { recursive: true })
          .pipe(mapStoreError("make-output-directory", outputPath));
        const encodedChunk = yield* encodeOutput(chunk).pipe(
          mapStoreError("encode-output", outputPath),
        );
        yield* Effect.tryPromise({
          try: () => NodeFSP.appendFile(outputPath, `${encodedChunk}\n`, "utf8"),
          catch: (cause) => storeError("append-output", outputPath, cause),
        });
      }),
    );

  const loadOutput = (outputPath: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(outputPath).pipe(mapStoreError("exists", outputPath)))) {
        return { chunks: [] as OutputChunk[], corruptLineCount: 0 };
      }
      const contents = yield* fs
        .readFileString(outputPath)
        .pipe(mapStoreError("read-output", outputPath));
      const chunks: OutputChunk[] = [];
      let corruptLineCount = 0;
      for (const line of contents.split("\n")) {
        if (line.length === 0) continue;
        const decoded = decodeOutput(line);
        if (decoded._tag === "Some") {
          chunks.push(decoded.value);
        } else {
          corruptLineCount += 1;
        }
      }
      return { chunks, corruptLineCount };
    });

  const loadMetadata = (projectId: string, runId: string) =>
    Effect.gen(function* () {
      const metadataPath = path.join(runDirectory(projectId, runId), "run.json");
      if (!(yield* fs.exists(metadataPath).pipe(mapStoreError("exists", metadataPath)))) {
        return null;
      }
      const metadataText = yield* fs
        .readFileString(metadataPath)
        .pipe(mapStoreError("read-run", metadataPath));
      const metadata = decodeMetadata(metadataText);
      return metadata._tag === "Some" ? metadata.value : null;
    });

  const loadRuns = (projectId: string) =>
    Effect.gen(function* () {
      const projectRunsRoot = path.join(runsRoot, projectId);
      if (!(yield* fs.exists(projectRunsRoot).pipe(mapStoreError("exists", projectRunsRoot)))) {
        return [];
      }
      const runIds = yield* fs
        .readDirectory(projectRunsRoot)
        .pipe(mapStoreError("read-run-directory", projectRunsRoot));
      const runs: AnalysisRunSnapshotType[] = [];
      for (const runId of runIds) {
        const metadata = yield* loadMetadata(projectId, runId);
        if (metadata !== null) runs.push(metadata);
      }
      return runs;
    });

  const loadRun = (projectId: string, runId: string) =>
    Effect.gen(function* () {
      const metadata = yield* loadMetadata(projectId, runId);
      if (metadata === null) return null;
      const { chunks, corruptLineCount } = yield* loadOutput(
        path.join(runDirectory(projectId, runId), "output.ndjson"),
      );
      if (corruptLineCount > 0) {
        chunks.push({
          sequence: (chunks.at(-1)?.sequence ?? -1) + 1,
          stream: "system",
          text: `${corruptLineCount} persisted output record${corruptLineCount === 1 ? " was" : "s were"} unreadable.\n`,
          observedAt: metadata.receipt.finishedAt ?? metadata.receipt.startedAt,
        });
      }
      const outputByteLength = chunks.reduce(
        (total, chunk) =>
          chunk.stream === "system"
            ? total
            : total + new TextEncoder().encode(chunk.text).byteLength,
        0,
      );
      return {
        ...metadata,
        receipt: {
          ...metadata.receipt,
          output: chunks,
          outputTruncated: metadata.receipt.outputTruncated || corruptLineCount > 0,
          outputByteLength,
          outputContentHash: corruptLineCount > 0 ? null : metadata.receipt.outputContentHash,
        },
      } satisfies AnalysisRunSnapshotType;
    });

  return LocalAnalysisStore.of({
    readRuntimeExecutablePath,
    writeRuntimeExecutablePath,
    persistRun,
    appendOutput,
    loadRuns,
    loadRun,
  });
});

export const layer = Layer.effect(LocalAnalysisStore, make);
