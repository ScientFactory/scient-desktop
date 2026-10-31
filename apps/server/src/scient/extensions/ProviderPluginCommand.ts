import { supportsScientClaudePlugins } from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  canonicalOmpExecutablePath,
  OmpExecutableGate,
} from "../../provider/omp/OmpExecutableGate.ts";
import { scientAgentTarget } from "../../provider/scient/ScientAgentTarget.ts";

const OUTPUT_LIMIT = 4 * 1024 * 1024;

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (state, chunk) => {
        if (state.bytes + chunk.length > OUTPUT_LIMIT)
          return Effect.fail({ message: "Agent command output exceeded 4 MiB." });
        state.chunks.push(chunk);
        state.bytes += chunk.length;
        return Effect.succeed(state);
      },
    ),
    Effect.map((state) => Buffer.concat(state.chunks).toString("utf8")),
  );

export const runProviderPluginCommand = Effect.fn("runProviderPluginCommand")(
  function* (executable: string, env: NodeJS.ProcessEnv, cwd: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = yield* resolveSpawnCommand(executable, args, { env, extendEnv: false });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        env,
        extendEnv: false,
        cwd,
        shell: command.shell,
        stdin: "ignore",
        forceKillAfter: "1 second",
      }),
    );
    const [stdout, , code] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (Number(code) !== 0)
      return yield* Effect.fail({ message: "The agent rejected the plugin command." });
    return stdout;
  },
  Effect.timeout("60 seconds"),
  Effect.scoped,
  Effect.mapError(() => ({ message: "The agent plugin command failed or timed out." })),
);

export const runScientAgentPluginCommand = Effect.fn("runScientAgentPluginCommand")(
  function* (executable: string, env: NodeJS.ProcessEnv, cwd: string, args: ReadonlyArray<string>) {
    const resolved =
      (yield* resolveCommandPath(executable, { env, bypassCache: true })) ?? executable;
    const identity = yield* canonicalOmpExecutablePath(resolved);
    const gate = yield* OmpExecutableGate;
    yield* gate.acquireProcess(identity, { target: scientAgentTarget, kind: "one-shot" });
    const info = yield* runProviderPluginCommand(resolved, env, cwd, ["--runtime-info"]);
    const runtime = scientAgentTarget.identify(info);
    if (!runtime) return yield* Effect.fail({ message: scientAgentTarget.unsupportedDetail });
    return yield* runProviderPluginCommand(
      resolved,
      {
        ...env,
        SCIENT_AGENT_ENABLE_SOURCES: supportsScientClaudePlugins(runtime.version)
          ? "claude-plugins"
          : undefined,
      },
      cwd,
      args,
    );
  },
  Effect.timeout("65 seconds"),
  Effect.scoped,
  Effect.mapError(() => ({ message: "Scient Agent could not complete the plugin command." })),
);
