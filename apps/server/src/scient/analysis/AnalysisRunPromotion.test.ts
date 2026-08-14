import {
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisArtifact,
  type AnalysisArtifactCandidate,
  type AnalysisRunSnapshot,
} from "@scientfactory/analysis";
import { ExecutionRunId, executionOutputContentParts } from "@scientfactory/execution";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { promoteAnalysisRun } from "./AnalysisRunPromotion.ts";
import { LocalAnalysisStore, layer as localAnalysisStoreLayer } from "./LocalAnalysisStore.ts";

const artifactId = AnalysisArtifactId.make("figure-001");
const representationId = AnalysisArtifactRepresentationId.make("static-png");
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function outputHash(output: AnalysisRunSnapshot["receipt"]["output"]): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of executionOutputContentParts(output)) hash.update(part, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function runFixture(artifacts: ReadonlyArray<AnalysisArtifact>): AnalysisRunSnapshot {
  const output = [
    {
      sequence: 0,
      stream: "stdout" as const,
      text: "complete\n",
      observedAt: "2026-08-14T10:00:01.000Z",
    },
  ];
  return {
    contractVersion: 1,
    projectId: "project-1",
    action: "run-file",
    runtime: {
      id: AnalysisRuntimeId.make("matlab:test"),
      kind: "matlab",
      label: "MATLAB",
      availability: "available",
      source: "custom",
      executablePath: "/test/matlab",
      version: "R2026a",
      detail: null,
      capabilities: ["run-file", "stream-output", "capture-artifacts"],
      inspectedAt: "2026-08-14T10:00:00.000Z",
      verification: null,
    },
    source: {
      cwd: "/private/project-path",
      relativePath: "experiments/waves.m",
      revision: AnalysisSourceRevision.make("sha256:source"),
    },
    phase: "finished",
    queuePosition: null,
    diagnostics: [],
    artifacts,
    artifactReceipt: { status: "succeeded", failureMessage: null },
    localStorage: {
      status: "retained",
      outputBytes: 9,
      artifactBytes: 3,
      totalBytes: 12,
      removedAt: null,
    },
    receipt: {
      runId: ExecutionRunId.make("run-1234567890"),
      status: "succeeded",
      startedAt: "2026-08-14T10:00:00.000Z",
      finishedAt: "2026-08-14T10:00:01.000Z",
      exitCode: 0,
      failureMessage: null,
      cancellationRequested: false,
      outputTruncated: false,
      outputByteLength: 9,
      outputContentHash: outputHash(output),
      output,
    },
  };
}

const candidates: ReadonlyArray<AnalysisArtifactCandidate> = [
  {
    artifactId,
    kind: "figure",
    label: "Wave figure",
    representations: [
      {
        representationId,
        fileName: AnalysisArtifactFileName.make("figure-001.png"),
        mediaType: "image/png",
        presentation: "static",
        requiresNetworkForFullExperience: false,
      },
    ],
  },
];

function fixtureEffect() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "scient-analysis-promotion-project-",
    });
    const baseDir = yield* fs.makeTempDirectoryScoped({
      prefix: "scient-analysis-promotion-state-",
    });
    const storeLayer = localAnalysisStoreLayer.pipe(
      Layer.provide(ServerConfig.ServerConfig.layerTest(workspaceRoot, baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LocalAnalysisStore;
        const staging = yield* store.prepareArtifactStaging("project-1", "run-1234567890");
        const files = path.join(staging, "files");
        yield* fs.makeDirectory(files, { recursive: true });
        yield* fs.writeFile(path.join(files, "figure-001.png"), new Uint8Array([1, 2, 3]));
        const artifacts = yield* store.publishArtifacts({
          projectId: "project-1",
          runId: "run-1234567890",
          createdAt: "2026-08-14T10:00:01.000Z",
          candidates,
        });
        const run = runFixture(artifacts);
        yield* store.persistRun(run);
        return { store, run };
      }).pipe(Effect.provide(storeLayer)),
    );
    return { fs, path, workspaceRoot, ...result };
  });
}

describe("analysis run promotion", () => {
  it.effect("atomically publishes verified output and artifacts and reuses the same result", () =>
    Effect.gen(function* () {
      const { fs, path, workspaceRoot, store, run } = yield* fixtureEffect();
      const first = yield* promoteAnalysisRun({
        workspaceRoot,
        run,
        createdAt: "2026-08-14T10:01:00.000Z",
        store,
      });
      expect(first).toMatchObject({
        directoryRelativePath: "results/waves/20260814T100000Z-run-12345678",
        artifactFileCount: 1,
        reused: false,
      });
      const resultDirectory = path.join(workspaceRoot, first.directoryRelativePath);
      expect(yield* fs.readFileString(path.join(resultDirectory, "output.txt"))).toBe("complete\n");
      expect([
        ...(yield* fs.readFile(path.join(resultDirectory, "artifacts", "figure-001.png"))),
      ]).toEqual([1, 2, 3]);
      const readmePath = path.join(resultDirectory, "README.md");
      const readme = yield* fs.readFileString(readmePath);
      expect(readme).toContain("![Wave figure](artifacts/figure-001.png)");
      expect(readme).toContain("## Notes and interpretation");

      yield* fs.writeFileString(readmePath, `${readme}Researcher note.\n`);
      const second = yield* promoteAnalysisRun({
        workspaceRoot,
        run,
        createdAt: "2026-08-14T10:02:00.000Z",
        store,
      });
      expect(second).toEqual({ ...first, reused: true });
      expect(yield* fs.readFileString(readmePath)).toContain("Researcher note.");
      expect(
        (yield* fs.readDirectory(path.dirname(resultDirectory))).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);

      const manifestText = yield* fs.readFileString(path.join(resultDirectory, "manifest.json"));
      const manifest = yield* decodeUnknownJsonString(manifestText);
      expect(manifest).toMatchObject({
        capsuleVersion: 1,
        kind: "scient-analysis-run",
        run: { runId: "run-1234567890" },
      });
      expect(manifestText).not.toContain("/private/project-path");
      expect(manifestText).not.toContain("/test/matlab");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails closed on a hash mismatch without leaving a partial project result", () =>
    Effect.gen(function* () {
      const { fs, path, workspaceRoot, store, run } = yield* fixtureEffect();
      const resolved = yield* store.resolveArtifact({
        projectId: run.projectId,
        runId: run.receipt.runId,
        artifactId,
        representationId,
      });
      expect(resolved).not.toBeNull();
      yield* fs.writeFile(resolved!.path, new Uint8Array([9, 9, 9]));

      const failure = yield* promoteAnalysisRun({
        workspaceRoot,
        run,
        createdAt: "2026-08-14T10:01:00.000Z",
        store,
      }).pipe(Effect.flip);
      expect(failure.reason).toBe("run-data-unavailable");
      const parent = path.join(workspaceRoot, "results", "waves");
      expect((yield* fs.readDirectory(parent)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(yield* fs.exists(path.join(parent, "20260814T100000Z-run-12345678"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never overwrites an unrelated destination", () =>
    Effect.gen(function* () {
      const { fs, path, workspaceRoot, store, run } = yield* fixtureEffect();
      const destination = path.join(
        workspaceRoot,
        "results",
        "waves",
        "20260814T100000Z-run-12345678",
      );
      yield* fs.makeDirectory(destination, { recursive: true });
      const userFile = path.join(destination, "README.md");
      yield* fs.writeFileString(userFile, "User-owned result\n");

      const failure = yield* promoteAnalysisRun({
        workspaceRoot,
        run,
        createdAt: "2026-08-14T10:01:00.000Z",
        store,
      }).pipe(Effect.flip);
      expect(failure.reason).toBe("destination-exists");
      expect(yield* fs.readFileString(userFile)).toBe("User-owned result\n");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses output that no longer matches the canonical run receipt", () =>
    Effect.gen(function* () {
      const { fs, path, workspaceRoot, store, run } = yield* fixtureEffect();
      const failure = yield* promoteAnalysisRun({
        workspaceRoot,
        run: {
          ...run,
          receipt: {
            ...run.receipt,
            output: [{ ...run.receipt.output[0]!, text: "changed\n" }],
          },
        },
        createdAt: "2026-08-14T10:01:00.000Z",
        store,
      }).pipe(Effect.flip);
      expect(failure.reason).toBe("run-data-unavailable");
      expect(
        yield* fs.exists(
          path.join(workspaceRoot, "results", "waves", "20260814T100000Z-run-12345678"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a symlinked results parent without writing outside the project", () =>
    Effect.gen(function* () {
      const { fs, path, workspaceRoot, store, run } = yield* fixtureEffect();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "scient-analysis-outside-" });
      yield* fs.symlink(outside, path.join(workspaceRoot, "results"));

      const failure = yield* promoteAnalysisRun({
        workspaceRoot,
        run,
        createdAt: "2026-08-14T10:01:00.000Z",
        store,
      }).pipe(Effect.flip);
      expect(failure.reason).toBe("destination-exists");
      expect(yield* fs.readDirectory(outside)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
