import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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

function makeLayer(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly hasCheckpointRef?: CheckpointStore.CheckpointStore["Service"]["hasCheckpointRef"];
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
        }),
      ),
    ),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = makeLayer({
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
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()) });

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
  const layer = makeLayer({
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

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = makeLayer({
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
        makeLayer({
          projection: Effect.succeed(workspaceProjection()),
          diffCheckpoints: diff,
          hasCheckpointRef: hasRef,
        }),
      ),
    );
  },
);

for (const scenario of ["missing metadata", "foreign baseline", "missing physical ref"] as const) {
  it.effect(
    `refuses ${scenario} without deriving a new-namespace zero or reading a foreign ref`,
    () => {
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
          makeLayer({
            projection: Effect.succeed({ ...projection, checkpoints }),
            diffCheckpoints: diff,
            hasCheckpointRef: () => Effect.succeed(scenario !== "missing physical ref"),
          }),
        ),
      );
    },
  );
}

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
        makeLayer({
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
      makeLayer({
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
      makeLayer({
        projection: Effect.die("unexpected metadata read"),
        diffCheckpoints: () => Effect.die("unexpected Git read"),
      }),
    ),
  );
});
