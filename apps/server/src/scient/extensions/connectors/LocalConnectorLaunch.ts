/**
 * Turns a stored local connector launch into the process Scient starts: its runtime found on this
 * computer, keys filled in from the vault, and Windows command shims run through cmd.exe.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { agentProcessEnvironment } from "../../../provider/agentProcessEnvironment.ts";

/** Stored per connector. Environment values may name vault-stored keys as `${secret:<name>}`. */
export interface LocalLaunchTemplate {
  /** `scient-node` runs on Scient's own Node; `system` looks the command up on PATH. */
  readonly runtime: "scient-node" | "system";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ResolvedLocalLaunch {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export class LocalLaunchError extends Schema.TaggedError<LocalLaunchError>()("LocalLaunchError", {
  message: Schema.String,
}) {}

const SECRET_PATTERN = /\$\{secret:([^}]+)\}/g;

const KNOWN_RUNTIMES: Readonly<Record<string, string>> = {
  npx: "Needs Node.js with npx on this computer.",
  node: "Needs Node.js on this computer.",
  uv: "Needs uv (docs.astral.sh/uv) on this computer.",
  uvx: "Needs uv (docs.astral.sh/uv) on this computer.",
  python: "Needs Python on this computer.",
  python3: "Needs Python on this computer.",
};

const missingProgram = (command: string) =>
  KNOWN_RUNTIMES[command.toLowerCase()] ??
  `Scient could not find ${command} on this computer. Install it or give its full path.`;

/** Why `command` cannot start here, or undefined when it can. */
export const programUnavailable = Effect.fn("LocalConnectorLaunch.programUnavailable")(function* (
  template: Pick<LocalLaunchTemplate, "runtime" | "command">,
) {
  if (template.runtime === "scient-node") {
    if (!(yield* HostProcess.IsExecutable)) return undefined;
    return (yield* resolveCommandPath("node")) === null ? missingProgram("node") : undefined;
  }
  const path = yield* Path.Path;
  if (path.isAbsolute(template.command)) {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(template.command).pipe(Effect.orElseSucceed(() => false)))
      ? undefined
      : `The program ${template.command} is not on this computer.`;
  }
  return (yield* resolveCommandPath(template.command)) === null
    ? missingProgram(template.command)
    : undefined;
});

export const resolveLocalLaunch = Effect.fn("LocalConnectorLaunch.resolve")(function* (
  template: LocalLaunchTemplate,
  secrets: Readonly<Record<string, string>>,
  cwd: string,
) {
  const unavailable = yield* programUnavailable(template);
  if (unavailable !== undefined) return yield* new LocalLaunchError({ message: unavailable });

  const platform = yield* HostProcess.Platform;
  // The user's login environment without Scient's internals, as agents get it.
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    agentProcessEnvironment({ baseEnv: yield* HostProcess.Environment, platform }),
  )) {
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(template.environment)) {
    let missing: string | undefined;
    environment[name] = value.replace(SECRET_PATTERN, (_match, key: string) => {
      const secret = secrets[key];
      if (secret === undefined) missing = key;
      return secret ?? "";
    });
    if (missing !== undefined) {
      return yield* new LocalLaunchError({
        message: `The key for ${missing} is missing. Remove this connector and add it again.`,
      });
    }
  }

  if (template.runtime === "scient-node") {
    if (yield* HostProcess.IsExecutable) {
      return {
        executable: (yield* resolveCommandPath("node"))!,
        args: template.args,
        shell: false,
        environment,
        cwd,
      } satisfies ResolvedLocalLaunch;
    }
    // Scient's desktop server is Electron in Node mode; its children need the same switch.
    environment.ELECTRON_RUN_AS_NODE = "1";
    return {
      executable: yield* HostProcess.ExecutablePath,
      args: template.args,
      shell: false,
      environment,
      cwd,
    } satisfies ResolvedLocalLaunch;
  }
  const spawn = yield* resolveSpawnCommand(template.command, template.args, { env: environment });
  return {
    executable: spawn.command,
    args: spawn.args,
    shell: spawn.shell,
    environment,
    cwd,
  } satisfies ResolvedLocalLaunch;
});

const quote = (part: string) => (/^[A-Za-z0-9_./:@=+-]+$/.test(part) ? part : JSON.stringify(part));

/** For display only: keys never reach it, since they live in the environment. */
export const commandLineOf = (template: Pick<LocalLaunchTemplate, "command" | "args">) =>
  [template.command, ...template.args].map(quote).join(" ").slice(0, 2_000);
