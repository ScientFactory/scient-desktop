import { supportsScientClaudePlugins } from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  canonicalOmpExecutablePath,
  OmpExecutableGate,
} from "../../provider/omp/OmpExecutableGate.ts";
import {
  scientAgentHostCommands,
  scientAgentTarget,
} from "../../provider/scient/ScientAgentTarget.ts";

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
  function* (
    executable: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly acceptNonZeroExit?: boolean },
  ) {
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
    if (Number(code) !== 0 && !options?.acceptNonZeroExit)
      return yield* Effect.fail({ message: "The agent rejected the plugin command." });
    return stdout;
  },
  Effect.timeout("60 seconds"),
  Effect.scoped,
  Effect.mapError(() => ({ message: "The agent plugin command failed or timed out." })),
);

/**
 * Resolves and leases the executable in the caller's scope, then reads its runtime info once.
 * Sources follow the identified build so plugin commands see what conversations load.
 */
const prepareScientAgent = Effect.fn("prepareScientAgent")(function* (
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  const resolved =
    (yield* resolveCommandPath(executable, { env, bypassCache: true })) ?? executable;
  const identity = yield* canonicalOmpExecutablePath(resolved);
  const gate = yield* OmpExecutableGate;
  yield* gate.acquireProcess(identity, { target: scientAgentTarget, kind: "one-shot" });
  const info = yield* runProviderPluginCommand(resolved, env, cwd, ["--runtime-info"]);
  const runtime = scientAgentTarget.identify(info);
  if (!runtime) return yield* Effect.fail({ message: scientAgentTarget.unsupportedDetail });
  return {
    resolved,
    hostCommands: scientAgentHostCommands(info),
    env: {
      ...env,
      SCIENT_AGENT_ENABLE_SOURCES: supportsScientClaudePlugins(runtime.version)
        ? "claude-plugins,codex-plugins"
        : undefined,
    },
  };
});

export const runScientAgentPluginCommand = Effect.fn("runScientAgentPluginCommand")(
  function* (executable: string, env: NodeJS.ProcessEnv, cwd: string, args: ReadonlyArray<string>) {
    const agent = yield* prepareScientAgent(executable, env, cwd);
    return yield* runProviderPluginCommand(agent.resolved, agent.env, cwd, args);
  },
  Effect.timeout("65 seconds"),
  Effect.scoped,
  Effect.mapError(() => ({ message: "Scient Agent could not complete the plugin command." })),
);

/**
 * Runs one of the agent's host commands, `undefined` when this build does not offer it (an older
 * one would read the word as a prompt). Its JSON error answer exits 1, so stdout is kept.
 */
export const runScientAgentHostCommand = Effect.fn("runScientAgentHostCommand")(
  function* (
    executable: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    args: readonly [string, ...string[]],
  ) {
    const agent = yield* prepareScientAgent(executable, env, cwd);
    if (!agent.hostCommands.includes(args[0])) return undefined;
    return yield* runProviderPluginCommand(agent.resolved, agent.env, cwd, args, {
      acceptNonZeroExit: true,
    });
  },
  Effect.timeout("75 seconds"),
  Effect.scoped,
  Effect.mapError(() => ({ message: "Scient Agent could not complete the command." })),
);

/**
 * Starts a long-running host command in the caller's scope, which owns the process: closing it
 * stops the command. `undefined` when this build does not offer it. Yields stdout lines.
 */
export const startScientAgentHostProcess = Effect.fn("startScientAgentHostProcess")(
  function* (
    executable: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    args: readonly [string, ...string[]],
  ) {
    const agent = yield* prepareScientAgent(executable, env, cwd);
    if (!agent.hostCommands.includes(args[0])) return undefined;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const childEnv = { ...agent.env, SCIENT_AGENT_HOST_PAGES: "1" };
    const command = yield* resolveSpawnCommand(agent.resolved, args, {
      env: childEnv,
      extendEnv: false,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        env: childEnv,
        extendEnv: false,
        cwd,
        shell: command.shell,
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    );
    return child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapError(() => ({ message: "Scient Agent's output could not be read." })),
    );
  },
  Effect.mapError(() => ({ message: "Scient Agent could not start the command." })),
);
