import {
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisRunSnapshot,
} from "@scientfactory/analysis";
import { ExecutionRunId } from "@scientfactory/execution";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { LocalAnalysisStore, layer } from "./LocalAnalysisStore.ts";

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownEffect(UnknownJsonString);
const encodeUnknownJson = Schema.encodeEffect(UnknownJsonString);

const run = {
  contractVersion: 1,
  projectId: "project-1",
  action: "run-file",
  runtime: {
    id: AnalysisRuntimeId.make("matlab:local"),
    kind: "matlab",
    label: "MATLAB",
    availability: "available",
    source: "path",
    executablePath: "/opt/matlab/bin/matlab",
    version: null,
    detail: null,
    capabilities: ["run-file", "stream-output", "cancel-process-tree"],
    inspectedAt: "2026-08-12T00:00:00.000Z",
  },
  source: {
    cwd: "/project",
    relativePath: "analysis.m",
    revision: AnalysisSourceRevision.make("sha256:source"),
  },
  receipt: {
    runId: ExecutionRunId.make("run-1"),
    status: "running",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    failureMessage: null,
    cancellationRequested: false,
    outputTruncated: false,
    outputByteLength: 19,
    outputContentHash: null,
    output: [],
  },
} satisfies AnalysisRunSnapshot;

describe("LocalAnalysisStore", () => {
  it.effect(
    "persists environment runtime settings and append-only run output across lifetimes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-analysis-store-",
        });
        const storeLayer = layer.pipe(
          Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* LocalAnalysisStore;
            yield* store.writeRuntimeExecutablePath("matlab", "/opt/matlab/bin/matlab");
            yield* store.persistRun(run);
            yield* store.appendOutput(run.projectId, run.receipt.runId, {
              sequence: 0,
              stream: "stdout",
              text: "scient-analysis-ok\n",
              observedAt: "2026-08-12T00:00:01.000Z",
            });
          }).pipe(Effect.provide(storeLayer)),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* LocalAnalysisStore;
            expect(yield* store.readRuntimeExecutablePath("matlab")).toBe("/opt/matlab/bin/matlab");
            const restored = yield* store.loadRuns(run.projectId);
            expect(restored).toHaveLength(1);
            expect(restored[0]).toMatchObject({
              source: run.source,
              receipt: { status: "running", output: [] },
            });
            const restoredWithOutput = yield* store.loadRun(run.projectId, run.receipt.runId);
            expect(restoredWithOutput).toMatchObject({
              receipt: {
                status: "running",
                output: [{ sequence: 0, stream: "stdout", text: "scient-analysis-ok\n" }],
              },
            });
          }).pipe(Effect.provide(storeLayer)),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("loads receipt metadata written before output content hashes were introduced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-analysis-store-legacy-",
      });
      const storeLayer = layer.pipe(
        Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalAnalysisStore;
          yield* store.persistRun(run);
        }).pipe(Effect.provide(storeLayer)),
      );

      const metadataPath = path.join(
        baseDir,
        "userdata",
        "analysis",
        "runs",
        run.projectId,
        run.receipt.runId,
        "run.json",
      );
      const legacyMetadata = yield* decodeUnknownJson(yield* fs.readFileString(metadataPath));
      if (
        typeof legacyMetadata !== "object" ||
        legacyMetadata === null ||
        !("receipt" in legacyMetadata) ||
        typeof legacyMetadata.receipt !== "object" ||
        legacyMetadata.receipt === null
      ) {
        throw new Error("Expected persisted analysis receipt metadata.");
      }
      delete (legacyMetadata.receipt as { outputContentHash?: unknown }).outputContentHash;
      yield* fs.writeFileString(metadataPath, yield* encodeUnknownJson(legacyMetadata));

      const restored = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalAnalysisStore;
          return yield* store.loadRun(run.projectId, run.receipt.runId);
        }).pipe(Effect.provide(storeLayer)),
      );

      expect(restored?.receipt.outputContentHash).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
