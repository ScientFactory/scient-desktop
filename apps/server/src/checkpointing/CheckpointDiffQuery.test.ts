import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        ordinalWithinScope: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function layerFor(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly hasCheckpointRef?: CheckpointStore.CheckpointStore["Service"]["hasCheckpointRef"];
  readonly authoredPaths?: ReadonlySet<string>;
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
          hasCheckpointRef: input.hasCheckpointRef ?? (() => Effect.succeed(true)),
          listAuthoredPaths: () => Effect.succeed(input.authoredPaths ?? null),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = layerFor({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.containSubset(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: yield* checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("leaves Git imports out of large turn diffs", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(
      input.format === "numstat"
        ? [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join("")
        : (input.filePaths ?? ["all"]).join("\n"),
    ),
  );
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints,
    authoredPaths: new Set(ownPaths),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    const patchPaths = diffCheckpoints.mock.calls
      .map(([call]) => call)
      .filter((call) => call.format !== "numstat")
      .map((call) => call.filePaths ?? ["all"]);
    assert.isAbove(patchPaths.length, 1);
    assert.sameMembers(patchPaths.flat(), ownPaths);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = layerFor({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = layerFor({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

function makeProjectionAfterStoppedRun(stoppedRunCheckpoint: boolean) {
  const thirdRunId = RunId.make("run:checkpoint-diff-v2:3");
  const checkpoint = (
    ordinalWithinScope: number,
    runId: RunId | null,
  ): ProjectionCheckpointContext["checkpoints"][number] => ({
    scopeId: firstScopeId,
    runId,
    ordinalWithinScope,
    appRunOrdinal: runId === null ? null : ordinalWithinScope,
    status: "ready",
    ref: CheckpointRef.make(`refs/t3/test/ordinal/${ordinalWithinScope}`),
  });
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "interrupted" },
      { id: thirdRunId, ordinal: 3, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: thirdRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "tool", cwd: "/repo" },
    ],
    checkpoints: [
      {
        ...checkpoint(2, null),
        scopeId: secondScopeId,
        ref: CheckpointRef.make("refs/t3/test/tool/2"),
      },
      checkpoint(0, null),
      checkpoint(1, firstRunId),
      checkpoint(2, stoppedRunCheckpoint ? secondRunId : null),
      checkpoint(3, thirdRunId),
    ],
  } satisfies ProjectionCheckpointContext;
}

it.effect.each([false, true])(
  "diffs the turn after a stopped run from its parent checkpoint (stopped run captured: %s)",
  (stoppedRunCheckpoint) => {
    const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
      Effect.succeed("diff --git a/file b/file"),
    );
    const layer = layerFor({
      projection: Effect.succeed(makeProjectionAfterStoppedRun(stoppedRunCheckpoint)),
      diffCheckpoints,
    });

    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 2, toTurnCount: 3 });

      assert.strictEqual(result.diff, "diff --git a/file b/file");
      yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 3 });
      yield* query.getFullThreadDiff({ threadId, toTurnCount: 3 });
      assert.deepEqual(
        diffCheckpoints.mock.calls.map(([input]) => ({
          from: input.fromCheckpointRef,
          to: input.toCheckpointRef,
        })),
        [
          { from: "refs/t3/test/ordinal/2", to: "refs/t3/test/ordinal/3" },
          { from: "refs/t3/test/ordinal/1", to: "refs/t3/test/ordinal/3" },
          {
            from: "refs/t3/test/ordinal/0",
            to: "refs/t3/test/ordinal/3",
          },
        ],
      );
      const stoppedTurnError = yield* query
        .getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 })
        .pipe(Effect.flip);
      assert.instanceOf(stoppedTurnError, CheckpointRefUnavailableError);
      assert.deepEqual(
        { checkpoint: stoppedTurnError.checkpoint, turnCount: stoppedTurnError.turnCount },
        { checkpoint: "to", turnCount: 2 },
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

const workspaceScopeId = CheckpointScopeId.make(
  "checkpoint-scope:thread:test:name:root-workspace-v1-test",
);
const baselineRef = CheckpointRef.make("refs/t3/test/baseline");
function workspaceProjection(): ProjectionCheckpointContext {
  const projection = makeProjection();
  return {
    ...projection,
    checkpointScopes: [
      { ...projection.checkpointScopes[0]!, cwd: "/other" },
      { ...projection.checkpointScopes[1]!, id: workspaceScopeId },
    ],
    checkpoints: [
      {
        ...projection.checkpoints[0]!,
        scopeId: firstScopeId,
        runId: firstRunId,
        appRunOrdinal: 1,
        ordinalWithinScope: 1,
        ref: CheckpointRef.make("refs/t3/test/foreign"),
      },
      {
        scopeId: workspaceScopeId,
        runId: null,
        appRunOrdinal: null,
        ordinalWithinScope: 0,
        status: "missing",
        ref: CheckpointRef.make("refs/t3/test/missing-zero"),
      },
      {
        scopeId: workspaceScopeId,
        runId: null,
        appRunOrdinal: null,
        ordinalWithinScope: 1,
        status: "ready",
        ref: baselineRef,
      },
      { ...projection.checkpoints[0]!, scopeId: workspaceScopeId },
    ],
  };
}

it.effect(
  "uses the ready nonzero workspace baseline for full and adjacent foreign-workspace reads",
  () => {
    const diff = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) => Effect.succeed("diff"));
    const hasRef = vi.fn(
      (_input: Parameters<CheckpointStore.CheckpointStore["Service"]["hasCheckpointRef"]>[0]) =>
        Effect.succeed(true),
    );
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
      assert.lengthOf(diff.mock.calls, 2);
      for (const [input] of diff.mock.calls)
        assert.deepEqual(input, {
          cwd: "/repo",
          fromCheckpointRef: baselineRef,
          toCheckpointRef: secondRef,
          fallbackFromToHead: false,
          ignoreWhitespace: true,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES + 1,
        });
      assert.deepEqual(
        hasRef.mock.calls.map(([input]) => input),
        [
          { cwd: "/repo", checkpointRef: baselineRef },
          { cwd: "/repo", checkpointRef: baselineRef },
        ],
      );
    }).pipe(
      Effect.provide(
        layerFor({
          projection: Effect.succeed(workspaceProjection()),
          diffCheckpoints: diff,
          hasCheckpointRef: hasRef,
        }),
      ),
    );
  },
);

it.effect.each(
  (["missing metadata", "foreign baseline", "missing physical ref"] as const).map((scenario) => ({
    caseTitle: `refuses ${scenario} without deriving a new-namespace zero or reading a foreign ref`,
    scenario,
  })),
)("$caseTitle", ({ scenario }) => {
  const projection = workspaceProjection();
  const diff = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("unexpected"),
  );
  const checkpoints = projection.checkpoints.map((checkpoint) =>
    checkpoint.ref !== baselineRef
      ? checkpoint
      : scenario === "missing metadata"
        ? { ...checkpoint, status: "missing" as const }
        : scenario === "foreign baseline"
          ? { ...checkpoint, scopeId: firstScopeId }
          : checkpoint,
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    for (const fromTurnCount of [0, 1]) {
      const error = yield* query
        .getTurnDiff({ threadId, fromTurnCount, toTurnCount: 2 })
        .pipe(Effect.flip);
      assert.instanceOf(error, CheckpointRefUnavailableError);
      assert.equal(error.checkpoint, "from");
      assert.equal(error.turnCount, fromTurnCount);
    }
    assert.lengthOf(diff.mock.calls, 0);
  }).pipe(
    Effect.provide(
      layerFor({
        projection: Effect.succeed({ ...projection, checkpoints }),
        diffCheckpoints: diff,
        hasCheckpointRef: () => Effect.succeed(scenario !== "missing physical ref"),
      }),
    ),
  );
});

it.effect(
  "preserves the earliest same-workspace historical baseline beside a new workspace scope",
  () => {
    const projection = workspaceProjection();
    const legacyRef = CheckpointRef.make("refs/t3/test/legacy-zero");
    const diff = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) => Effect.succeed("diff"));
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      assert.equal(diff.mock.calls[0]?.[0].fromCheckpointRef, legacyRef);
    }).pipe(
      Effect.provide(
        layerFor({
          projection: Effect.succeed({
            ...projection,
            checkpointScopes: projection.checkpointScopes
              .toReversed()
              .map((scope) => ({ ...scope, cwd: "/repo" })),
            checkpoints: [
              ...projection.checkpoints,
              {
                scopeId: firstScopeId,
                runId: null,
                appRunOrdinal: null,
                ordinalWithinScope: 0,
                status: "ready",
                ref: legacyRef,
              },
            ],
          }),
          diffCheckpoints: diff,
        }),
      ),
    );
  },
);

it.effect("checks physical availability of historical derived-zero refs", () => {
  const diff = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("unexpected"),
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 }).pipe(Effect.flip);
    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.equal(error.checkpoint, "from");
    assert.lengthOf(diff.mock.calls, 0);
  }).pipe(
    Effect.provide(
      layerFor({
        projection: Effect.succeed(makeProjection()),
        diffCheckpoints: diff,
        hasCheckpointRef: () => Effect.succeed(false),
      }),
    ),
  );
});

it.effect("keeps equal-zero reads empty without looking up metadata or Git", () => {
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    assert.equal((yield* query.getFullThreadDiff({ threadId, toTurnCount: 0 })).diff, "");
    assert.equal(
      (yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 0 })).diff,
      "",
    );
  }).pipe(
    Effect.provide(
      layerFor({
        projection: Effect.die("unexpected metadata read"),
        diffCheckpoints: () => Effect.die("unexpected Git read"),
      }),
    ),
  );
});

it.effect.each(["historical", "workspace-bound"] as const)(
  "keeps an implicit historical zero before newer explicit baseline metadata: %s",
  (laterKind) =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const laterScopeId = laterKind === "historical" ? secondScopeId : workspaceScopeId;
      const legacyRef = yield* checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      });
      const diff = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
        Effect.succeed("full historical diff"),
      );
      const hasRef = vi.fn(
        (_input: Parameters<CheckpointStore.CheckpointStore["Service"]["hasCheckpointRef"]>[0]) =>
          Effect.succeed(true),
      );
      return yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        assert.equal(
          (yield* query.getFullThreadDiff({ threadId, toTurnCount: 2, ignoreWhitespace: false }))
            .diff,
          "full historical diff",
        );
        assert.deepEqual(
          hasRef.mock.calls.map(([input]) => input),
          [{ cwd: "/repo", checkpointRef: legacyRef }],
        );
        assert.deepEqual(
          diff.mock.calls.map(([input]) => input),
          [
            {
              cwd: "/repo",
              fromCheckpointRef: legacyRef,
              toCheckpointRef: secondRef,
              fallbackFromToHead: false,
              ignoreWhitespace: false,
              maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES + 1,
            },
          ],
        );
      }).pipe(
        Effect.provide(
          layerFor({
            projection: Effect.succeed({
              ...projection,
              checkpointScopes: projection.checkpointScopes
                .toReversed()
                .map((scope) =>
                  scope.id === secondScopeId ? { ...scope, id: laterScopeId } : scope,
                ),
              checkpoints: [
                {
                  scopeId: laterScopeId,
                  runId: null,
                  appRunOrdinal: null,
                  ordinalWithinScope: 1,
                  status: "ready",
                  ref: baselineRef,
                },
                { ...projection.checkpoints[0]!, scopeId: laterScopeId },
              ],
            }),
            diffCheckpoints: diff,
            hasCheckpointRef: hasRef,
          }),
        ),
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect.each(["historical", "workspace-bound"] as const)(
  "refuses to narrow history when an eligible implicit legacy source ref is absent: %s",
  (laterKind) =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const laterScopeId = laterKind === "historical" ? secondScopeId : workspaceScopeId;
      const legacyRef = yield* checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      });
      const diff = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
        Effect.succeed("unexpected narrowed diff"),
      );
      return yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const error = yield* query
          .getFullThreadDiff({ threadId, toTurnCount: 2 })
          .pipe(Effect.flip);
        assert.instanceOf(error, CheckpointRefUnavailableError);
        assert.equal(error.checkpoint, "from");
        assert.equal(error.turnCount, 0);
        assert.lengthOf(diff.mock.calls, 0);
      }).pipe(
        Effect.provide(
          layerFor({
            projection: Effect.succeed({
              ...projection,
              checkpointScopes: projection.checkpointScopes.map((scope) =>
                scope.id === secondScopeId ? { ...scope, id: laterScopeId } : scope,
              ),
              checkpoints: [
                {
                  scopeId: laterScopeId,
                  runId: null,
                  appRunOrdinal: null,
                  ordinalWithinScope: 1,
                  status: "ready",
                  ref: baselineRef,
                },
                { ...projection.checkpoints[0]!, scopeId: laterScopeId },
              ],
            }),
            diffCheckpoints: diff,
            hasCheckpointRef: (input) => Effect.succeed(input.checkpointRef !== legacyRef),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
);
const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provide(NodeServices.layer),
);
const layerTest = Layer.merge(layerStore, layerVcsProcess).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("shares the turn and full-thread diff budget across real Git batches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-diff-aggregate-" });
    const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
      process.run({
        operation: "CheckpointDiffQuery.test.git",
        command: "git",
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      });
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const threadId = ThreadId.make("thread:aggregate-runtime");
    const runId = RunId.make("run:aggregate-runtime");
    const scopeId = CheckpointScopeId.make("scope:aggregate-runtime");
    const fromCheckpointRef = yield* checkpointRefForScopeOrdinal({
      scopeId,
      ordinalWithinScope: 0,
    });
    const toCheckpointRef = CheckpointRef.make("refs/t3/test/aggregate-after");
    yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
    // The old commit models files imported by a pull after the baseline was captured.
    yield* fs.writeFileString(path.join(cwd, "upstream.ts"), "imported\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "imported"], {
      ...globalThis.process.env,
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    const ownPaths = Array.from({ length: 1_600 }, (_, index) => `src/module-${index}/file.ts`);
    yield* Effect.forEach(
      ownPaths,
      (file) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
          yield* fs.writeFileString(path.join(cwd, file), `${"x".repeat(12_000)}\n`);
        }),
      { concurrency: 16, discard: true },
    );
    yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });

    const patchSizes: number[] = [];
    const query = yield* CheckpointDiffQuery.make.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [{ id: runId, ordinal: 1, status: "completed" }],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
              checkpoints: [
                {
                  scopeId,
                  runId,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "ready",
                  ref: toCheckpointRef,
                },
              ],
            }),
        }),
      ),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        ...store,
        diffCheckpoints: (input) =>
          store.diffCheckpoints(input).pipe(
            Effect.tap((patch) =>
              Effect.sync(() => {
                if (input.format !== "numstat") {
                  patchSizes.push(Buffer.byteLength(patch));
                }
              }),
            ),
          ),
      }),
    );
    const turn = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
    const turnPatchSizes = patchSizes.splice(0);
    const fullThread = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });
    assert.isTrue(fullThread.diff === turn.diff);
    assert.isAtMost(Buffer.byteLength(turn.diff), 10_000_000);
    assert.isTrue(turn.diff.endsWith("\n\n[truncated]"));
    assert.include(turn.diff, "src/module-0/file.ts");
    assert.notInclude(turn.diff, "upstream.ts");
    assert.lengthOf(turnPatchSizes, 2);
    assert.deepEqual(patchSizes, turnPatchSizes);
    assert.isBelow(turnPatchSizes[0]!, 10_000_000);
    assert.strictEqual(
      turnPatchSizes.reduce((sum, size) => sum + size, 0),
      10_000_001,
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("truncates a storage-cut UTF-8 character without replacement text", () => {
  const prefix = "x".repeat(9_999_985);
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints: (input) =>
      Effect.succeed(
        Buffer.from(`${prefix}😀${"x".repeat(9)}😀tail`)
          .subarray(0, input.maxOutputBytes)
          .toString("utf8"),
      ),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 });
    assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
    assert.isTrue(result.diff === `${prefix}\n\n[truncated]`);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves an exact-fit filtered patch across batches without a marker", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  const patches = ["é".repeat(3_000_000), "x".repeat(4_000_000)];
  let patchReads = 0;
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    authoredPaths: new Set(ownPaths),
    diffCheckpoints: (input) =>
      Effect.sync(() =>
        input.format === "numstat"
          ? [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join("")
          : patches[patchReads++]!,
      ),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.isTrue(result.diff === patches.join(""));
    assert.strictEqual(patchReads, 2);
  }).pipe(Effect.provide(layer));
});
