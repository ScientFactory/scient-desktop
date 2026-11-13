/**
 * The automatic maintenance checkpoint publication no longer triggers, run by the server instead:
 * Git's own `maintenance run --auto --task=gc` (its lock, thresholds and cruft expiry), in the
 * foreground, one repository at a time, after a quiet period, at most once per interval, stopped
 * with the server. A repository that turned automatic maintenance off is left alone.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import { ResourceRecord } from "../scient/observability/ResourceRecord.ts";
import { CHECKPOINT_PACK_MEMORY_CONFIG, checkpointCleanGitEnv } from "./ScientCheckpointCapture.ts";

/** Wait this long after a repository's latest checkpoint, so a busy session runs upkeep once. */
export const UPKEEP_QUIET_PERIOD = Duration.minutes(2);
/** Run upkeep for one repository at most this often. */
export const UPKEEP_MIN_INTERVAL = Duration.minutes(30);
/** After a failed run, leave the repository alone this long. */
export const UPKEEP_FAILURE_BACKOFF = Duration.hours(6);
/** How often the worker looks for due repositories. */
export const UPKEEP_TICK = Duration.seconds(30);
/** A larger repository may repack for a long time; stop it rather than hold it forever. */
const UPKEEP_TIMEOUT = Duration.minutes(30);
/** Git's default expiry, the shortest this upkeep prunes with: a capture's borrowed objects survive. */
const SAFE_PRUNE_EXPIRE = "2.weeks.ago";
const SAFE_PRUNE_EXPIRE_SECONDS = 14 * 24 * 60 * 60;

export interface UpkeepPolicy {
  /** `maintenance.auto=false`: the person turned automatic maintenance off here. */
  readonly disabled: boolean;
  /** `gc.pruneExpire` would prune objects younger than two weeks, unsafe beside a capture. */
  readonly prunesTooSoon: boolean;
}

/**
 * From `git config --type=bool --get maintenance.auto` and `git config --type=expiry-date --get
 * gc.pruneExpire` (seconds since the epoch; `now` reads as the largest value, `never` as 0).
 */
export function parseUpkeepPolicy(input: {
  readonly maintenanceAuto: string;
  readonly pruneExpire: string;
  readonly nowSeconds: number;
}): UpkeepPolicy {
  const cutoff = Number(input.pruneExpire.trim());
  return {
    disabled: input.maintenanceAuto.trim() === "false",
    prunesTooSoon:
      input.pruneExpire.trim() !== "" &&
      Number.isFinite(cutoff) &&
      cutoff > input.nowSeconds - SAFE_PRUNE_EXPIRE_SECONDS,
  };
}

/** Foreground maintenance with the checkpoint pack's memory settings. */
export function upkeepGitArgs(gitCommonDir: string, policy: UpkeepPolicy): ReadonlyArray<string> {
  return [
    "-c",
    "maintenance.autoDetach=false",
    "-c",
    "gc.autoDetach=false",
    ...CHECKPOINT_PACK_MEMORY_CONFIG,
    ...(policy.prunesTooSoon ? ["-c", `gc.pruneExpire=${SAFE_PRUNE_EXPIRE}`] : []),
    "--git-dir",
    gitCommonDir,
    "maintenance",
    "run",
    "--auto",
    "--task=gc",
    "--quiet",
  ];
}

export class CheckpointUpkeep extends Context.Service<
  CheckpointUpkeep,
  {
    /** Note a checkpoint published into the repository whose common Git directory this is. */
    readonly request: (gitCommonDir: string) => Effect.Effect<void>;
  }
>()("t3/vcs/ScientCheckpointUpkeep/CheckpointUpkeep") {}

interface RepositoryState {
  /** Upkeep may start once the clock passes this. */
  dueAt: number;
  requested: boolean;
}

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const record = yield* Effect.serviceOption(ResourceRecord);
  const repositories = new Map<string, RepositoryState>();
  const git = (args: ReadonlyArray<string>, cwd: string, timeout: Duration.Input) =>
    runner
      .run({
        command: "git",
        args,
        cwd,
        env: checkpointCleanGitEnv(),
        timeout,
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.result);

  const request = (gitCommonDir: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const quietUntil = now + Duration.toMillis(UPKEEP_QUIET_PERIOD);
        const state = repositories.get(gitCommonDir);
        if (state === undefined) {
          repositories.set(gitCommonDir, { dueAt: quietUntil, requested: true });
          return;
        }
        // A new checkpoint restarts the quiet period but never shortens an interval or backoff.
        state.dueAt = Math.max(state.dueAt, quietUntil);
        state.requested = true;
      }),
    );

  const runUpkeep = Effect.fnUntraced(function* (gitCommonDir: string, state: RepositoryState) {
    state.requested = false;
    const readConfig = (type: string, key: string) =>
      git(
        ["--git-dir", gitCommonDir, "config", `--type=${type}`, "--get", key],
        gitCommonDir,
        "30 seconds",
      ).pipe(
        Effect.map((result) =>
          result._tag === "Success" && result.success.code === 0 ? result.success.stdout : "",
        ),
      );
    const policy = parseUpkeepPolicy({
      maintenanceAuto: yield* readConfig("bool", "maintenance.auto"),
      pruneExpire: yield* readConfig("expiry-date", "gc.pruneExpire"),
      nowSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    });
    if (policy.disabled) {
      state.dueAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(UPKEEP_MIN_INTERVAL);
      return;
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* git(upkeepGitArgs(gitCommonDir, policy), gitCommonDir, UPKEEP_TIMEOUT);
    const now = yield* Clock.currentTimeMillis;
    const succeeded = outcome._tag === "Success" && outcome.success.code === 0;
    if (Option.isSome(record)) {
      yield* record.value.note("checkpoint-upkeep", {
        durationMs: now - startedAt,
        outcome: succeeded ? "done" : "failed",
      });
    }
    state.dueAt = now + Duration.toMillis(succeeded ? UPKEEP_MIN_INTERVAL : UPKEEP_FAILURE_BACKOFF);
    if (!succeeded) {
      yield* Effect.logWarning("checkpoint repository upkeep failed", {
        gitCommonDir,
        ...(outcome._tag === "Success"
          ? { exitCode: outcome.success.code, stderr: outcome.success.stderr.slice(0, 2_000) }
          : { error: outcome.failure._tag }),
      });
    }
  });

  // One worker: repositories are maintained one after another, never in parallel. Each is checked
  // again just before it runs, since a checkpoint can arrive while an earlier repository runs.
  const runDue = Effect.gen(function* () {
    for (const [gitCommonDir, state] of repositories) {
      if (state.requested && state.dueAt <= (yield* Clock.currentTimeMillis)) {
        yield* runUpkeep(gitCommonDir, state);
      }
    }
  });
  yield* Effect.sleep(UPKEEP_TICK).pipe(Effect.andThen(runDue), Effect.forever, Effect.forkScoped);

  return CheckpointUpkeep.of({ request });
});

export const layer = Layer.effect(CheckpointUpkeep, make);
