import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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

it.effect("streams an idle snapshot, a job started elsewhere, and its settled state", () =>
  Effect.gen(function* () {
    const jobs = yield* makeNotebookRunJobs;
    const idle = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const key = "project/notebook";
    const subscription = yield* jobs.watch(key).pipe(
      Stream.tap(({ job }) => {
        if (job === null) return Deferred.succeed(idle, undefined);
        if (job.outcome === undefined) return Deferred.succeed(running, undefined);
        return Effect.succeed(false);
      }),
      Stream.dropWhile(({ settledRunId }) => settledRunId === null),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Deferred.await(idle);
    const outcome = { _tag: "failed", message: "Run completed with an error." } as const;
    const { runId } = yield* jobs.start(key, () => Deferred.await(finish).pipe(Effect.as(outcome)));
    yield* Deferred.await(running);
    yield* Deferred.succeed(finish, undefined);
    const settled = { job: { runId, outcome }, settledRunId: runId };
    expect(yield* Fiber.join(subscription)).toEqual(Option.some(settled));

    const next = yield* jobs.start(key, () => Effect.never);
    expect(yield* jobs.watch(key).pipe(Stream.runHead)).toEqual(
      Option.some({ job: next, settledRunId: runId }),
    );
    expect(yield* jobs.watch("other/notebook").pipe(Stream.runHead)).toEqual(
      Option.some({ job: null, settledRunId: null }),
    );
  }).pipe(Effect.scoped),
);
