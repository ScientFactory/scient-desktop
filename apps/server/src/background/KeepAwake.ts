import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
// SCIENT-FORK:START — busy means Scient's executing work, not any open run.
import * as ScientKeepAwakeWork from "../scient/keepAwake/KeepAwakeService.ts";
// SCIENT-FORK:END
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

// Bridges gaps between back-to-back runs, so a long-idle machine does not sleep mid-queue.
const RELEASE_GRACE = Duration.seconds(60);

/** Each command holds its inhibitor until it exits, and exits on its own if the server dies. */
function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-i", "-w", String(serverPid)] };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          // SCIENT-FORK: the name Linux shows for the inhibitor.
          "--who=Scient",
          "--why=Agents are working",
          "--mode=block",
          "tail",
          `--pid=${serverPid}`,
          "-f",
          "/dev/null",
        ],
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this thread until Wait-Process returns.
          // SCIENT-FORK: the Scient namespace for the PowerShell type.
          `$t = Add-Type -Name Power -Namespace Scient -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${serverPid}`,
        ],
      };
    default:
      return undefined;
  }
}

/**
 * Runs `hold` while `wanted` is true and for `grace` after it turns false; a true inside the
 * grace keeps the same hold. `hold` runs until interrupted.
 */
export const holdWhileWanted = <E, R>(
  wanted: Stream.Stream<boolean, E, R>,
  hold: Effect.Effect<void>,
  grace: Duration.Input = RELEASE_GRACE,
) =>
  wanted.pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on ? Stream.succeed(true) : Stream.fromEffect(Effect.as(Effect.sleep(grace), false)),
    ),
    Stream.changes,
    Stream.switchMap((on) => (on ? Stream.fromEffect(hold) : Stream.empty)),
    Stream.runDrain,
  );

// Reads, the event subscription and the inhibitor retry until they succeed; the cap keeps a
// host without an inhibitor (e.g. no logind) from retrying and warning constantly.
const backoff = Schedule.exponential("5 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(10))),
  ),
);
const retryWithBackoff =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning(message, { cause })),
      Effect.retry(backoff),
    );

class KeepAwakeInhibitorExited extends Schema.TaggedError<KeepAwakeInhibitorExited>()(
  "KeepAwakeInhibitorExited",
  { exitCode: Schema.Number },
) {}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const command = inhibitorCommand(yield* HostProcess.Platform, process.pid);
    if (command === undefined) return;
    const settings = yield* Settings.ServerSettingsService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // SCIENT-FORK:START — Scient's work: executing threads with a live owner, not monitors, PR
    // watches, threads waiting on a person or another thread. It reads thread shells, so it is
    // re-read on any thread event (batched), and each minute for what changes without one: a
    // provider session ending, and a run's start grace running out.
    const scientWork = yield* ScientKeepAwakeWork.KeepAwakeService;
    const hasActiveRun = scientWork.work.pipe(
      Effect.map((work) => work.working.length > 0),
      retryWithBackoff("keep-awake could not read active runs"),
    );
    // SCIENT-FORK:END
    // Read the cursor before the snapshot so a run changing in between is replayed, not missed.
    const active = Stream.unwrap(
      events.latestApplicationSequence.pipe(
        retryWithBackoff("keep-awake could not read the event cursor"),
        Effect.map((afterSequence) =>
          Stream.concat(
            Stream.succeed(undefined),
            // SCIENT-FORK:START — any thread event can change Scient's work; see scientWork.
            Stream.merge(
              events.streamApplicationEvents({ afterSequence }).pipe(
                Stream.filter((stored) => "event" in stored),
                Stream.groupedWithin(10_000, "1 second"),
              ),
              Stream.tick("1 minute").pipe(Stream.drop(1)),
            ),
            // SCIENT-FORK:END
          ),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => hasActiveRun),
      // A failed subscription resubscribes, which re-reads the cursor and the snapshot.
      Stream.tapCause((cause) =>
        Effect.logWarning("keep-awake run event stream failed", { cause }),
      ),
      Stream.retry(backoff),
    );
    const enabled = Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* settings.subscribeChanges;
        const current = yield* settings.getSettings.pipe(
          Effect.map((value) => value.keepAwakeWhileAgentsWork),
          Effect.orElseSucceed(() => true),
        );
        return Stream.concat(
          Stream.succeed(current),
          Stream.map(changes, (value) => value.keepAwakeWhileAgentsWork),
        );
      }),
    );

    const holdOnce = spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          detached: false,
          shell: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.tap((child) =>
          Effect.logInfo("keep-awake holding sleep inhibitor", { pid: Number(child.pid) }),
        ),
        Effect.tap(() =>
          Effect.addFinalizer(() => Effect.logInfo("keep-awake released sleep inhibitor")),
        ),
        Effect.flatMap((child) => child.exitCode),
        Effect.flatMap((exitCode) =>
          Effect.fail(new KeepAwakeInhibitorExited({ exitCode: Number(exitCode) })),
        ),
        Effect.scoped,
      );
    const hold = holdOnce.pipe(
      retryWithBackoff("keep-awake sleep inhibitor stopped"),
      Effect.ignore,
    );

    yield* forkParked(
      holdWhileWanted(
        Stream.zipLatestWith(enabled, active, (on, busy) => on && busy),
        hold,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause }))),
    );
  }),
);
