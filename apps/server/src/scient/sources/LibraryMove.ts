// @effect-diagnostics nodeBuiltinImport:off -- Moves are keyed by the project folder's real path.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ScientSourceActor } from "@scientfactory/scient-sources";
import {
  moveScientProjectBackIntoProject,
  readScientLibraryMoveState,
  readScientLibraryMoveStatus,
  runScientLibraryMove,
  type ScientLibraryMoveBackResult,
  type ScientLibraryMoveFaults,
  type ScientLibraryMoveOutcome,
  type ScientLibraryMoveProgress,
} from "@scientfactory/scient-sources/library-move";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import type { ScientSourcesMoveStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

/**
 * How long a write call waits for its project's move before it gets the retryable message. Under
 * the 100 s many proxies allow a remote request and the 60 s that outside MCP clients often give a
 * tool call; Scient's own agents allow 65 minutes. A project of about 1,500 sources moves within
 * it on the measured machine; larger ones answer once or twice with their progress.
 */
export const ScientLibraryMoveWait = Context.Reference<Duration.Input>(
  "scient/sources/ScientLibraryMoveWait",
  { defaultValue: () => "20 seconds" },
);

/** Tests pause or crash this server's moves through this reference; production leaves it empty. */
export const ScientLibraryMoveTestFaults = Context.Reference<
  ScientLibraryMoveFaults & {
    /** Called each time this server starts a move, never when a caller joins one. */
    readonly onRun?: () => void;
    /** Called when a caller waits for a move or move back already running. */
    readonly onJoin?: () => void;
  }
>("scient/sources/ScientLibraryMoveTestFaults", { defaultValue: () => ({}) });

export class ScientLibraryMoveBusyError extends Schema.TaggedError<ScientLibraryMoveBusyError>()(
  "ScientLibraryMoveBusyError",
  { message: Schema.String },
) {}

interface MoveRun {
  readonly kind: "move" | "move-back";
  progress: ScientLibraryMoveProgress | null;
  settled: Promise<void>;
}

/**
 * One move or move back per project in this server, keyed by the folder's real path, and the
 * reason the last one failed. Process state like the store's own lock queues: every caller joins
 * the run already going, and only progress lives here, never in the journal.
 */
const runs = new Map<string, MoveRun>();
const failures = new Map<string, string>();

function track<A>(
  key: string,
  kind: MoveRun["kind"],
  start: (onProgress: (progress: ScientLibraryMoveProgress) => void) => Promise<A>,
): { readonly run: MoveRun; readonly result: Promise<A> } {
  const run: MoveRun = { kind, progress: null, settled: Promise.resolve() };
  const result = start((progress) => {
    run.progress = progress;
  });
  runs.set(key, run);
  run.settled = result.then(
    () => {
      failures.delete(key);
    },
    (error: unknown) => {
      failures.set(key, failureReason(error));
    },
  );
  void run.settled.finally(() => {
    if (runs.get(key) === run) runs.delete(key);
  });
  return { run, result };
}

/** Store errors with an errno can name host paths; those are reported without them. */
function failureReason(error: unknown): string {
  if (error instanceof Error && !("code" in error) && error.message.length > 0) {
    return error.message;
  }
  return "A file in the project or the Library could not be read or written.";
}

const count = (value: number) => value.toLocaleString("en-US");

function progressText(progress: ScientLibraryMoveProgress | null): string {
  if (!progress) return "";
  const of = `${count(progress.done)} of ${count(progress.total)}`;
  switch (progress.phase) {
    case "sources":
    case "restoring":
      return ` (${of})`;
    case "files":
      return ` (copying PDFs, ${of})`;
    case "verifying":
      return ` (checking the copies, ${of})`;
    case "merging":
      return " (merging duplicates)";
    case "switching":
      return " (switching over)";
    case "cleaning-up":
      return ` (removing the old files, ${of})`;
  }
}

/** The retryable message a write call gets while its project's sources are still moving. */
function scientLibraryMoveBusyMessage(run: Pick<MoveRun, "kind" | "progress">): string {
  return run.kind === "move"
    ? `This project's sources are still moving into your Library${progressText(run.progress)}. Try again shortly.`
    : `This project's sources are still moving back into the project${progressText(run.progress)}. Try again shortly.`;
}

const canonicalRoot = (root: string) => NodeFSP.realpath(root).catch(() => NodePath.resolve(root));

/** The project list's title for a checkout, matched by real path; none without the list. */
const projectTitleFor = Effect.fn("ScientLibraryMove.projectTitle")(function* (root: string) {
  const store = yield* Effect.serviceOption(ProjectStoreV2);
  if (Option.isNone(store)) return undefined;
  const projects = yield* store.value.list().pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    if ((yield* Effect.promise(() => canonicalRoot(project.workspaceRoot))) === root) {
      return project.title;
    }
  }
  return undefined;
});

/**
 * `git ls-files .scient/sources` through the server's git driver. Without the driver, or outside
 * a repository, nothing is tracked. Scient never commits; the status line asks the person to.
 */
const libraryMoveGitTracked = Effect.fn("ScientLibraryMove.gitTracked")(function* (root: string) {
  const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  if (Option.isNone(git)) return false;
  const result = yield* git.value
    .execute({
      operation: "ScientLibraryMove.gitTracked",
      cwd: root,
      args: ["ls-files", "-z", "--", ".scient/sources"],
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    })
    .pipe(Effect.orElseSucceed(() => null));
  return result !== null && result.exitCode === 0 && result.stdout.length > 0;
});

export type ScientLibraryMoveRunOutcome = ScientLibraryMoveOutcome | "failed";

/**
 * Waits for a run, up to the bound when there is one. Past it the call fails with the run's
 * progress; the run itself goes on.
 */
const awaitRun = Effect.fn("ScientLibraryMove.await")(function* <A>(
  run: MoveRun,
  result: Promise<A>,
  bound: Duration.Duration | null,
) {
  const settled = Effect.promise(() =>
    result.then(
      (value) => ({ value }) as const,
      (error: unknown) => ({ error }) as const,
    ),
  );
  if (bound === null) return yield* settled;
  const waited = Duration.isZero(bound)
    ? Option.none()
    : yield* settled.pipe(Effect.timeoutOption(bound));
  if (Option.isSome(waited)) return waited.value;
  return yield* new ScientLibraryMoveBusyError({ message: scientLibraryMoveBusyMessage(run) });
});

/**
 * Moves the project into the library, or finishes what the journal left; write callers and the
 * background pass only. A run already going for the project is joined, never started twice. A
 * write waits up to `ScientLibraryMoveWait`, then fails with `ScientLibraryMoveBusyError`.
 */
export const moveProjectIntoLibrary = Effect.fn("ScientLibraryMove.run")(function* (input: {
  readonly root: string;
  readonly library: ScientLibraryLocation;
  readonly actor: ScientSourceActor;
  readonly wait?: "bounded" | "until-done";
}) {
  const key = yield* Effect.promise(() => canonicalRoot(input.root));
  const bound =
    input.wait === "until-done" ? null : Duration.fromInputUnsafe(yield* ScientLibraryMoveWait);
  const faults = yield* ScientLibraryMoveTestFaults;
  const context = yield* Effect.context<never>();
  while (true) {
    const running = runs.get(key);
    if (running) {
      faults.onJoin?.();
      // Whatever it was, the project's state is read again once it ends.
      yield* awaitRun(running, running.settled, bound);
      continue;
    }
    const state = yield* Effect.promise(() =>
      readScientLibraryMoveState({ library: input.library, projectRoot: key }).catch(() => null),
    );
    if (!state) return "failed" satisfies ScientLibraryMoveRunOutcome;
    if (state.journal?.state === "moved-back") return "moved-back";
    const unfinished = state.journal !== null && state.journal.state !== "done";
    if (!state.v1Present && !unfinished) return state.journal ? "moved" : "not-needed";
    // Another caller may have started while the state was read.
    if (runs.has(key)) continue;
    faults.onRun?.();
    const projectTitle = yield* projectTitleFor(key);
    const { run, result } = track(key, "move", (onProgress) =>
      runScientLibraryMove({
        library: input.library,
        projectRoot: key,
        actor: input.actor,
        projectTitle,
        gitTracked: () => Effect.runPromiseWith(context)(libraryMoveGitTracked(key)),
        faults,
        onProgress,
      }),
    );
    const settled = yield* awaitRun(run, result, bound);
    if ("error" in settled) {
      yield* Effect.logWarning("Moving the project's Sources into the library failed.", {
        root: key,
        cause: settled.error,
      });
      return "failed" satisfies ScientLibraryMoveRunOutcome;
    }
    return settled.value.outcome;
  }
});

/**
 * "Move back into this project", registered like a move: status shows it as restoring, and a
 * write call that arrives meanwhile joins it. A move still running for the project ends first.
 */
export async function moveProjectBackIntoProject(input: {
  readonly root: string;
  readonly library: ScientLibraryLocation;
  readonly actor: ScientSourceActor;
}): Promise<ScientLibraryMoveBackResult> {
  const key = await canonicalRoot(input.root);
  for (let running = runs.get(key); running; running = runs.get(key)) await running.settled;
  return track(key, "move-back", (onProgress) =>
    moveScientProjectBackIntoProject({
      library: input.library,
      projectRoot: key,
      actor: input.actor,
      onProgress,
    }),
  ).result;
}

/**
 * One status for a project's move: a running move or move back from memory, a failure this
 * server saw, otherwise what the journal says. Reads only.
 */
export const readLibraryMoveStatus = Effect.fn("ScientLibraryMove.status")(function* (input: {
  readonly root: string;
  readonly library: ScientLibraryLocation | null;
}) {
  const key = yield* Effect.promise(() => canonicalRoot(input.root));
  const running = runs.get(key);
  if (running) {
    return {
      state: running.kind === "move" ? "moving" : "restoring",
      progress: running.progress,
    } satisfies ScientSourcesMoveStatus;
  }
  const failure = failures.get(key);
  if (failure !== undefined) return { state: "failed", reason: failure } as const;
  const disk = yield* Effect.promise(() =>
    readScientLibraryMoveStatus({ library: input.library, projectRoot: key }).then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    ),
  );
  if ("error" in disk) return { state: "failed", reason: failureReason(disk.error) } as const;
  const { status } = disk;
  if (status.state === "restoring") return { state: "restoring", progress: null } as const;
  return status satisfies ScientSourcesMoveStatus;
});

/**
 * The move as an agent sees it in `scient_sources_list`: one line while it says something,
 * null once there is nothing to tell (nothing to move, moved back, a summary dismissed).
 */
export function scientLibraryMoveNotice(status: ScientSourcesMoveStatus): {
  readonly state: "waiting" | "moving" | "done" | "cleanup-pending" | "restoring" | "failed";
  readonly message: string;
} | null {
  switch (status.state) {
    case "nothing-to-move":
    case "moved-back":
      return null;
    case "waiting":
      return {
        state: status.state,
        message:
          "This project's sources are not in the Library yet; the first change moves them there.",
      };
    case "moving":
    case "restoring":
      return {
        state: status.state,
        message: scientLibraryMoveBusyMessage({
          kind: status.state === "moving" ? "move" : "move-back",
          progress: status.progress,
        }).replace(" Try again shortly.", ""),
      };
    case "done":
      return status.lines.length === 0
        ? null
        : { state: status.state, message: status.lines.join(" ") };
    case "cleanup-pending":
      return {
        state: status.state,
        message: [
          ...status.lines,
          `${count(status.filesLeft)} old ${status.filesLeft === 1 ? "file" : "files"} could not be removed yet; Scient tries again later.`,
        ].join(" "),
      };
    case "failed":
      return {
        state: status.state,
        message: `Moving this project's sources into the Library failed: ${status.reason} The next change tries again.`,
      };
  }
}
