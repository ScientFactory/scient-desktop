import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeNotebookRunJobs } from "./NotebookRunJobs.ts";

it.effect("keeps an accepted run after its caller stops waiting", () =>
  Effect.gen(function* () {
    const jobs = yield* makeNotebookRunJobs;
    const finish = yield* Deferred.make<void>();
    const accepted = yield* Deferred.make<string>();
    const request = yield* Effect.gen(function* () {
      const job = yield* jobs.start("project/notebook", () =>
        Deferred.await(finish).pipe(
          Effect.as({ _tag: "failed" as const, message: "A notebook cell failed." }),
        ),
      );
      yield* Deferred.succeed(accepted, job.runId);
      return yield* jobs.wait("project/notebook", job.runId);
    }).pipe(Effect.forkChild);

    const id = yield* Deferred.await(accepted);
    yield* Fiber.interrupt(request);
    const job = yield* jobs.status("project/notebook");
    expect(job).toEqual({ runId: id });
    expect(yield* jobs.status("other/notebook", job!.runId)).toBeNull();
    yield* Deferred.succeed(finish, undefined);
    const finished = yield* jobs.wait("project/notebook", job!.runId);
    expect(finished).toEqual({ _tag: "failed", message: "A notebook cell failed." });
    expect(yield* jobs.status("project/notebook", job!.runId)).toEqual({
      runId: id,
      outcome: finished,
    });
  }).pipe(Effect.scoped),
);

it.effect("exposes running values and stops only the addressed notebook job", () =>
  Effect.gen(function* () {
    const jobs = yield* makeNotebookRunJobs;
    const started = yield* Deferred.make<void>();
    const job = yield* jobs.start("project/notebook", (report) =>
      Effect.gen(function* () {
        report({
          parameters: { threshold: "0.7" },
          progress: { phase: "running", cell: 2, total: 10 },
        });
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    yield* Deferred.await(started);
    expect(yield* jobs.status("project/notebook")).toMatchObject({
      parameters: { threshold: "0.7" },
      progress: { phase: "running", cell: 2, total: 10 },
    });
    expect(yield* jobs.stop("other/notebook", job.runId)).toBeNull();
    yield* jobs.stop("project/notebook", job.runId);
    expect(yield* jobs.wait("project/notebook", job.runId)).toEqual({
      _tag: "failed",
      message: "The notebook run was stopped.",
    });
  }).pipe(Effect.scoped),
);
