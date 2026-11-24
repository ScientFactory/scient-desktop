import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ComputeSessionService } from "../compute/ComputeSessionService.ts";
import { ComputeWorkspaceAdmission } from "../compute/ComputeWorkspaceAdmission.ts";
import * as NotebookRunRecorder from "./NotebookRunRecorder.ts";
import { NotebookStore } from "./NotebookStore.ts";

const run = (cell: string | undefined, startedAt: string | null) =>
  ({
    projectId: "project",
    root: "/project",
    workspace: { scope: { workspaceRoot: "/project" }, assertCurrent: Effect.void },
    execution: {
      request: {
        sessionId: "session",
        executionId: `run-${cell}`,
        code: "1",
        submittedAt: "2026-11-01T00:00:00.000Z",
        source: { _tag: "document", path: "study.ipynb", ...(cell ? { cell } : {}) },
      },
      result: { startedAt, finishedAt: "2026-11-01T00:00:01.000Z", executionCount: 3 },
    },
  }) as never;

describe("recording a notebook's runs on the server", () => {
  it.effect(
    "records a cell's run as its workspace, keeping its output until the file is saved",
    () =>
      Effect.gen(function* () {
        const recorded = yield* Deferred.make<ReadonlyArray<string | null>>();
        const released = yield* Deferred.make<void>();
        const events: string[] = [];
        const compute = {
          settledRuns: Stream.fromIterable([
            run(undefined, "2026-11-01T00:00:00.000Z"),
            run("c1", "2026-11-01T00:00:00.000Z"),
          ]),
          // The real service refuses a bound session to a caller with no admission.
          getSession: () =>
            Effect.gen(function* () {
              const admission = yield* ComputeWorkspaceAdmission;
              return {
                projectId: "project",
                sessionId: "session",
                root: admission?.scope.workspaceRoot,
              };
            }),
          listOutputs: () => Effect.succeed({ outputs: [] }),
          settledRunRecorded: (_sessionId: string, executionId: string) =>
            executionId === "run-c1"
              ? Effect.sync(() => events.push("released")).pipe(
                  Effect.andThen(Deferred.succeed(released, undefined)),
                )
              : Effect.void,
        };
        const notebooks = {
          recordRun: (
            request: { readonly cellId: string },
            outputs: (input: never) => Effect.Effect<unknown, { readonly message: string }>,
          ) =>
            outputs({} as never).pipe(
              Effect.andThen(ComputeWorkspaceAdmission),
              Effect.flatMap((admission) =>
                Deferred.succeed(recorded, [
                  request.cellId,
                  admission?.scope.workspaceRoot ?? null,
                ]),
              ),
              Effect.as({ cell: {} }),
              Effect.orDie,
            ),
          flush: () => Effect.sync(() => events.push("saved")),
        };
        yield* Layer.build(
          NotebookRunRecorder.layer.pipe(
            Layer.provide(Layer.succeed(ComputeSessionService, compute as never)),
            Layer.provide(Layer.succeed(NotebookStore, notebooks as never)),
            Layer.provide(FileSystem.layerNoop({})),
            Layer.provide(Path.layer),
          ),
        );
        expect(yield* Deferred.await(recorded)).toEqual(["c1", "/project"]);
        yield* Deferred.await(released);
        expect(events).toEqual(["saved", "released"]);
      }).pipe(Effect.scoped),
  );
});
