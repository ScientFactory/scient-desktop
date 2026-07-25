// FILE: claudeCliVersion.ts
// Purpose: Resolve the exact Claude CLI version used for a provider session.
// Layer: Provider runtime helper

import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { parseGenericCliVersion } from "./providerMaintenance";

const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 4_000;

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export function resolveClaudeCliVersion(input: {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const prepared = prepareWindowsSafeProcess(input.executable, ["--version"], {
      env: input.env,
    });
    const command = ChildProcess.make(prepared.command, prepared.args, {
      shell: prepared.shell,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: input.env,
      stdin: "ignore",
      cwd: input.cwd,
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) return null;
    return parseGenericCliVersion(`${stdout}\n${stderr}`);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(CLAUDE_VERSION_PROBE_TIMEOUT_MS),
    Effect.map(Option.getOrElse((): string | null => null)),
    Effect.catch(() => Effect.succeed(null)),
  );
}
