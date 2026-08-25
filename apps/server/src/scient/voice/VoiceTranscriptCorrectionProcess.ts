import { VoiceTranscriptCorrectionError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const MAX_PROVIDER_STDOUT_CHARS = 64 * 1024;

function providerFailure(message: string): VoiceTranscriptCorrectionError {
  return new VoiceTranscriptCorrectionError({ kind: "provider-error", message });
}

function collectBoundedText<E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, VoiceTranscriptCorrectionError> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (current, chunk) => `${current}${chunk}`.slice(-MAX_PROVIDER_STDOUT_CHARS),
    ),
    Effect.mapError(() => providerFailure("The AI provider response could not be read.")),
  );
}

export function runVoiceTranscriptCorrectionProcess(input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly prompt: string;
}): Effect.Effect<string, VoiceTranscriptCorrectionError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(input.binaryPath, input.args, {
        env: input.environment,
      }).pipe(
        Effect.mapError(() => providerFailure("The AI provider command could not be resolved.")),
      );
      const child = yield* input.spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: input.cwd,
            env: input.environment,
            extendEnv: false,
            shell: resolved.shell,
            stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
            stdout: { stream: "pipe" },
            stderr: { stream: "pipe" },
          }),
        )
        .pipe(Effect.mapError(() => providerFailure("The AI provider could not be started.")));

      const { stdout, exitCode } = yield* Effect.all(
        {
          stdout: collectBoundedText(child.stdout),
          stderr: child.stderr.pipe(
            Stream.runDrain,
            Effect.orElseSucceed(() => undefined),
          ),
          exitCode: child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(() => providerFailure("The AI provider did not exit cleanly.")),
          ),
        },
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* providerFailure(`The AI provider exited with code ${exitCode}.`);
      }
      return stdout;
    }),
  );
}
