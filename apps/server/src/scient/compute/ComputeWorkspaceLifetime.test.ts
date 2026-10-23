import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  withComputeWorkspaceReservation,
  withoutComputeWorkspaceOwners,
} from "./ComputeWorkspaceLifetime.ts";

describe("Compute workspace lifetime", () => {
  it.effect("defers admission while retaining per-run spans, receipts and finalizer scope", () =>
    Effect.gen(function* () {
      let admissions = 0;
      let removed = 0;
      const operation = withComputeWorkspaceReservation("/test/lazy-reservation", (release) =>
        Effect.gen(function* () {
          admissions++;
          yield* Effect.addFinalizer(() => release);
          const span = yield* Effect.currentSpan;
          return [span, release] as const;
        }),
      );
      const remove = withoutComputeWorkspaceOwners(
        "/test/lazy-reservation",
        Effect.sync(() => removed++),
      );
      assert.strictEqual(admissions, 0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* operation;
          const second = yield* operation;
          assert.strictEqual(admissions, 2);
          assert.strictEqual(
            first[0].name,
            "ComputeWorkspaceLifetime.withComputeWorkspaceReservation",
          );
          assert.strictEqual(second[0].name, first[0].name);
          assert.notStrictEqual(second[0].spanId, first[0].spanId);
          assert.notStrictEqual(second[1], first[1]);
          yield* remove;
          assert.strictEqual(removed, 0);
        }),
      );
      yield* remove;
      assert.strictEqual(removed, 1);
    }).pipe(Effect.withTracerEnabled(true)),
  );

  it.effect("retains the worktree until every descendant owner releases it", () =>
    Effect.gen(function* () {
      let removed = 0;
      const remove = withoutComputeWorkspaceOwners(
        "/test/lifetime",
        Effect.sync(() => {
          removed++;
        }),
      );
      const first = yield* withComputeWorkspaceReservation("/test/lifetime", Effect.succeed);
      const second = yield* withComputeWorkspaceReservation(
        "/test/lifetime/subproject",
        Effect.succeed,
      );
      yield* remove;
      expect(removed).toBe(0);
      yield* first;
      yield* first;
      yield* remove;
      expect(removed).toBe(0);
      yield* second;
      yield* remove;
      expect(removed).toBe(1);
    }),
  );

  it.effect("blocks new owners throughout removal without blocking unrelated workspaces", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const deletion = yield* withoutComputeWorkspaceOwners(
        "/test/removing",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const error = yield* withComputeWorkspaceReservation(
        "/test/removing/sub",
        (release) => release,
      ).pipe(Effect.flip);
      expect(error.reason).toBe("workspace-changed");
      yield* withComputeWorkspaceReservation("/test/unrelated", (release) => release);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(deletion);
      yield* withComputeWorkspaceReservation("/test/removing/sub", (release) => release);
    }),
  );

  it.effect("releases failed admission and failed removal reservations", () =>
    Effect.gen(function* () {
      yield* withComputeWorkspaceReservation("/test/failed", () => Effect.fail("startup")).pipe(
        Effect.flip,
      );
      const error = yield* withoutComputeWorkspaceOwners("/test/failed", Effect.fail("git")).pipe(
        Effect.flip,
      );
      expect(error).toBe("git");
      yield* withComputeWorkspaceReservation("/test/failed", (release) => release);
    }),
  );
});
