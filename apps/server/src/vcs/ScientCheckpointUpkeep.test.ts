import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as Upkeep from "./ScientCheckpointUpkeep.ts";

interface Run {
  readonly gitCommonDir: string;
  readonly args: ReadonlyArray<string>;
}

const gitDirOf = (args: ReadonlyArray<string>) => args[args.indexOf("--git-dir") + 1]!;

const succeeded = (): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

// `runs` records maintenance runs; the policy read before each answers with `config`.
const makeUpkeep = Effect.fn(function* (
  run: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<ProcessRunner.ProcessRunOutput>,
  config: (gitCommonDir: string, key: string) => string = () => "",
) {
  const runs: Array<Run> = [];
  const scope = yield* Scope.make();
  const upkeep = yield* Upkeep.make.pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) => {
          const gitCommonDir = gitDirOf(input.args);
          if (input.args.includes("config")) {
            const stdout = config(gitCommonDir, input.args.at(-1)!);
            return Effect.succeed({
              ...succeeded(),
              code: ChildProcessSpawner.ExitCode(stdout === "" ? 1 : 0),
              stdout,
            });
          }
          return Effect.sync(() => runs.push({ gitCommonDir, args: input.args })).pipe(
            Effect.andThen(run(input)),
          );
        },
      }),
    ),
    Scope.provide(scope),
  );
  return { upkeep, runs, scope };
});

const advance = (duration: Duration.Input) => TestClock.adjust(duration);

it.effect("runs Git's own automatic gc maintenance once after a burst of checkpoints", () =>
  Effect.gen(function* () {
    const { upkeep, runs } = yield* makeUpkeep(() => Effect.succeed(succeeded()));
    for (let turn = 0; turn < 5; turn++) {
      yield* upkeep.request("/repo/.git");
      yield* advance("40 seconds");
    }
    assert.strictEqual(runs.length, 0, "no upkeep while checkpoints keep arriving");
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    const policy = { disabled: false, prunesTooSoon: false };
    assert.deepStrictEqual(runs, [
      { gitCommonDir: "/repo/.git", args: Upkeep.upkeepGitArgs("/repo/.git", policy) },
    ]);
    // Foreground, under Git's maintenance lock: never a detached repack, never a bare gc.
    assert.includeMembers(
      [...runs[0]!.args],
      ["maintenance.autoDetach=false", "maintenance", "run", "--auto", "--task=gc"],
    );
  }),
);

it.effect("leaves a repository with automatic maintenance turned off alone", () =>
  Effect.gen(function* () {
    const { upkeep, runs } = yield* makeUpkeep(
      () => Effect.succeed(succeeded()),
      (gitCommonDir, key) =>
        gitCommonDir === "/off/.git" && key === "maintenance.auto" ? "false\n" : "",
    );
    yield* upkeep.request("/off/.git");
    yield* upkeep.request("/on/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    assert.deepStrictEqual(
      runs.map((run) => run.gitCommonDir),
      ["/on/.git"],
    );
  }),
);

it.effect("never prunes objects younger than two weeks, whatever gc.pruneExpire says", () =>
  Effect.gen(function* () {
    const { upkeep, runs } = yield* makeUpkeep(
      () => Effect.succeed(succeeded()),
      // `1.second.ago` as Git reports it: a cutoff one second before now (test clock: 0).
      (_, key) => (key === "gc.pruneExpire" ? "-1\n" : ""),
    );
    yield* upkeep.request("/repo/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    assert.includeMembers([...runs[0]!.args], ["gc.pruneExpire=2.weeks.ago"]);
  }),
);

it.effect("waits a repository's renewed quiet period even when it was queued behind another", () =>
  Effect.gen(function* () {
    const { upkeep, runs } = yield* makeUpkeep((input) =>
      gitDirOf(input.args) === "/a/.git"
        ? Effect.sleep("1 minute").pipe(Effect.as(succeeded()))
        : Effect.succeed(succeeded()),
    );
    yield* upkeep.request("/a/.git");
    yield* upkeep.request("/b/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    // A runs for a minute; meanwhile B receives another checkpoint.
    yield* upkeep.request("/b/.git");
    yield* advance("1 minute");
    assert.deepStrictEqual(
      runs.map((run) => run.gitCommonDir),
      ["/a/.git"],
      "B waits for its new quiet period",
    );
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    assert.deepStrictEqual(
      runs.map((run) => run.gitCommonDir),
      ["/a/.git", "/b/.git"],
    );
  }),
);

it("reads the repository's maintenance policy", () => {
  const nowSeconds = 1_800_000_000;
  const policy = (maintenanceAuto: string, pruneExpire: string) =>
    Upkeep.parseUpkeepPolicy({ maintenanceAuto, pruneExpire, nowSeconds });
  assert.deepStrictEqual(policy("", ""), { disabled: false, prunesTooSoon: false });
  assert.deepStrictEqual(policy("false\n", ""), { disabled: true, prunesTooSoon: false });
  // now, one second ago, a day ago: too soon. Two weeks or longer, and never (0): kept.
  for (const cutoff of ["18446744073709551615", `${nowSeconds - 1}`, `${nowSeconds - 86_400}`]) {
    assert.isTrue(policy("", cutoff).prunesTooSoon, cutoff);
  }
  for (const cutoff of [`${nowSeconds - 14 * 86_400}`, `${nowSeconds - 30 * 86_400}`, "0"]) {
    assert.isFalse(policy("", cutoff).prunesTooSoon, cutoff);
  }
});

it.effect("maintains one repository at a time", () =>
  Effect.gen(function* () {
    let active = 0;
    let mostActive = 0;
    const { upkeep, runs } = yield* makeUpkeep(() =>
      Effect.sync(() => {
        active++;
        mostActive = Math.max(mostActive, active);
      }).pipe(
        Effect.andThen(Effect.sleep("5 minutes")),
        Effect.ensuring(Effect.sync(() => active--)),
        Effect.as(succeeded()),
      ),
    );
    yield* upkeep.request("/a/.git");
    yield* upkeep.request("/b/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    yield* advance("5 minutes");
    yield* advance("5 minutes");
    assert.deepStrictEqual(
      runs.map((run) => run.gitCommonDir),
      ["/a/.git", "/b/.git"],
    );
    assert.strictEqual(mostActive, 1);
  }),
);

it.effect("waits the interval after a run and backs off after a failure", () =>
  Effect.gen(function* () {
    let code = 0;
    const { upkeep, runs } = yield* makeUpkeep(() =>
      Effect.succeed({ ...succeeded(), code: ChildProcessSpawner.ExitCode(code) }),
    );
    const settle = Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK);
    yield* upkeep.request("/repo/.git");
    yield* advance(settle);
    assert.strictEqual(runs.length, 1);

    yield* upkeep.request("/repo/.git");
    yield* advance(settle);
    assert.strictEqual(runs.length, 1, "a second run waits for the interval");
    yield* advance(Upkeep.UPKEEP_MIN_INTERVAL);
    assert.strictEqual(runs.length, 2);

    code = 128;
    yield* upkeep.request("/repo/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_MIN_INTERVAL, Upkeep.UPKEEP_TICK));
    assert.strictEqual(runs.length, 3, "this run fails");
    code = 0;
    yield* upkeep.request("/repo/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_MIN_INTERVAL, Upkeep.UPKEEP_TICK));
    assert.strictEqual(runs.length, 3, "a failed repository is left alone for the backoff");
    yield* advance(Upkeep.UPKEEP_FAILURE_BACKOFF);
    assert.strictEqual(runs.length, 4);
  }),
);

it.effect("does nothing until a checkpoint asks for it", () =>
  Effect.gen(function* () {
    const { runs } = yield* makeUpkeep(() => Effect.succeed(succeeded()));
    yield* advance("2 hours");
    assert.strictEqual(runs.length, 0);
  }),
);

it.effect("stops a running upkeep when the server stops", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const { upkeep, runs, scope } = yield* makeUpkeep(() =>
      Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    );
    yield* upkeep.request("/repo/.git");
    yield* advance(Duration.sum(Upkeep.UPKEEP_QUIET_PERIOD, Upkeep.UPKEEP_TICK));
    assert.strictEqual(runs.length, 1);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(yield* Deferred.isDone(interrupted));
  }),
);

// The layer must not need anything the server does not already provide to every driver.
it.effect("builds from the process runner alone", () =>
  Effect.gen(function* () {
    const upkeep = yield* Upkeep.CheckpointUpkeep;
    yield* upkeep.request("/repo/.git");
  }).pipe(
    Effect.provide(
      Upkeep.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ProcessRunner.ProcessRunner,
            ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(succeeded()) }),
          ),
        ),
      ),
    ),
  ),
);
