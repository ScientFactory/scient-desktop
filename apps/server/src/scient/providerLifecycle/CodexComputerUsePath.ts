import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { parse as parseToml } from "smol-toml";

/**
 * Temporary (openai/codex#35448): ChatGPT writes the `computer-use` MCP server with a relative command, which
 * Codex resolves against its own working directory, so it never starts. Launch Codex with absolute paths for
 * that exact entry; the user's config is never changed. Remove once the entry is written with absolute paths.
 */
const SERVER = "computer-use";
const RELATIVE_COMMAND =
  "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A TOML basic string, which `codex -c key=value` parses as the value. */
const tomlString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const readServerEntry = (contents: string): unknown => {
  try {
    const servers = (parseToml(contents) as { readonly mcp_servers?: unknown }).mcp_servers;
    return isRecord(servers) ? servers[SERVER] : undefined;
  } catch {
    return undefined;
  }
};

/** `-c` overrides that make the ChatGPT-written Computer Use server start, or none. */
export const codexComputerUsePathArgs = Effect.fn("codexComputerUsePathArgs")(function* (
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Effect.fn.Return<ReadonlyArray<string>> {
  if ((yield* HostProcess.Platform) !== "darwin") return [];
  const home = environment.HOME?.trim() || (yield* HostProcess.HomeDirectory);
  const codexHome = environment.CODEX_HOME?.trim() || path.join(home, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const contents = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return [];

  const entry = readServerEntry(contents);
  if (
    !isRecord(entry) ||
    entry.enabled === false ||
    entry.command !== RELATIVE_COMMAND ||
    (entry.cwd !== undefined && entry.cwd !== "." && entry.cwd !== "./")
  ) {
    return [];
  }

  // A shadow Codex home links config.toml from the shared home, where the program is installed.
  const linkedHome = yield* fileSystem.realPath(configPath).pipe(
    Effect.map((real) => path.dirname(real)),
    Effect.orElseSucceed(() => codexHome),
  );
  for (const directory of new Set([codexHome, linkedHome].map((dir) => path.join(dir, SERVER)))) {
    const program = path.join(directory, RELATIVE_COMMAND);
    const isFile = yield* fileSystem.stat(program).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (isFile) {
      return [
        "-c",
        `mcp_servers.${SERVER}.command=${tomlString(program)}`,
        "-c",
        `mcp_servers.${SERVER}.cwd=${tomlString(directory)}`,
      ];
    }
  }
  return [];
});
