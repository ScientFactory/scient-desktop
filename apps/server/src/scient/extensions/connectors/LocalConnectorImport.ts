// @effect-diagnostics nodeBuiltinImport:off -- Reads other apps' MCP settings files on this computer.
/**
 * Local MCP servers other apps already run on this computer (Claude Desktop, Claude Code, Codex,
 * Cursor) and servers listed in a folder's `.mcp.json`. Only stdio servers are offered. Variable
 * values stay on the server: clients see names, and Add reads the file again.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { LocalImportSource, LocalImportableServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Toml from "smol-toml";

import { commandLineOf } from "./LocalConnectorLaunch.ts";

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const KEY_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|CREDENTIAL|AUTH)(?:_|$)/i;

const StdioServer = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
});
const decodeStdioServer = Schema.decodeUnknownExit(StdioServer);
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObject = Schema.decodeUnknownExit(JsonObject);

export interface ImportedServer {
  readonly source: LocalImportSource;
  readonly sourceLabel: string;
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** Where the other app runs it; Scient runs it there too. */
  readonly cwd: string | undefined;
}

export const looksLikeKey = (name: string) => KEY_NAME.test(name);

const KEY_FLAG =
  /^--?[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pat|credential|auth)[A-Za-z0-9_-]*$/i;

/** The flag of the first argument that passes a key on the command line, if any. */
/** `--flag=value` split at its first `=`; the value keeps any further `=`. */
const flagOf = (arg: string) => {
  const at = arg.indexOf("=");
  return at === -1
    ? { flag: arg, value: undefined }
    : { flag: arg.slice(0, at), value: arg.slice(at + 1) };
};

export const keyArgument = (args: ReadonlyArray<string>): string | undefined => {
  for (const [index, arg] of args.entries()) {
    const { flag, value } = flagOf(arg);
    if (!KEY_FLAG.test(flag)) continue;
    if (value !== undefined && value !== "") return flag;
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) return flag;
  }
  return undefined;
};

/** Arguments for display, with any value given to a key flag left out. */
const maskedArgs = (args: ReadonlyArray<string>) =>
  args.map((arg, index) => {
    const { flag, value } = flagOf(arg);
    if (KEY_FLAG.test(flag) && value !== undefined) return `${flag}=…`;
    const previous = args[index - 1];
    return previous !== undefined &&
      KEY_FLAG.test(previous) &&
      !previous.includes("=") &&
      !arg.startsWith("-")
      ? "…"
      : arg;
  });

const APP_LABELS = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
} as const;

const readText = (file: string) =>
  Effect.promise(async () => {
    try {
      const stat = await NodeFSP.stat(file);
      return stat.isFile() && stat.size <= MAX_SETTINGS_BYTES
        ? await NodeFSP.readFile(file, "utf8")
        : undefined;
    } catch {
      return undefined;
    }
  });

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Stdio entries of an `mcpServers`-style map; remote ones are added by URL instead. */
const serversOf = (
  servers: unknown,
  source: LocalImportSource,
  sourceLabel: string,
  cwd: string | undefined,
): ReadonlyArray<ImportedServer> =>
  isObject(servers)
    ? Object.entries(servers).flatMap(([name, raw]) => {
        const decoded = decodeStdioServer(raw);
        if (Exit.isFailure(decoded) || decoded.value.command.trim() === "") return [];
        const server = decoded.value;
        return [
          {
            source,
            sourceLabel,
            name,
            command: server.command.trim(),
            args: server.args ?? [],
            env: server.env ?? {},
            cwd: server.cwd ?? cwd,
          },
        ];
      })
    : [];

const jsonServers = Effect.fn("LocalConnectorImport.json")(function* (
  file: string,
  source: LocalImportSource,
  sourceLabel: string,
  cwd: string | undefined,
) {
  const text = yield* readText(file);
  if (text === undefined) return [];
  const parsed = decodeJsonObject(text);
  return Exit.isSuccess(parsed) ? serversOf(parsed.value.mcpServers, source, sourceLabel, cwd) : [];
});

const claudeDesktopSettings = (
  home: string,
  platform: NodeJS.Platform,
  appData: string | undefined,
) =>
  platform === "darwin"
    ? NodePath.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : platform === "win32"
      ? NodePath.join(
          appData ?? NodePath.join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        )
      : NodePath.join(home, ".config", "Claude", "claude_desktop_config.json");

/** Claude Code keeps user servers at the top of `~/.claude.json` and local ones per folder. */
const claudeCodeServers = Effect.fn("LocalConnectorImport.claudeCode")(function* (home: string) {
  const source = { type: "app", app: "claude-code" } as const;
  const text = yield* readText(NodePath.join(home, ".claude.json"));
  if (text === undefined) return [];
  const parsed = decodeJsonObject(text);
  if (Exit.isFailure(parsed)) return [];
  const projects = isObject(parsed.value.projects) ? parsed.value.projects : {};
  return [
    ...serversOf(parsed.value.mcpServers, source, APP_LABELS["claude-code"], undefined),
    ...Object.entries(projects).flatMap(([folder, project]) =>
      isObject(project)
        ? serversOf(
            project.mcpServers,
            { ...source, folder },
            `${APP_LABELS["claude-code"]} · ${NodePath.basename(folder)}`,
            folder,
          )
        : [],
    ),
  ];
});

const codexServers = Effect.fn("LocalConnectorImport.codex")(function* (home: string) {
  const text = yield* readText(NodePath.join(home, ".codex", "config.toml"));
  if (text === undefined) return [];
  const parsed = yield* Effect.try({ try: () => Toml.parse(text), catch: () => undefined }).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return parsed === undefined
    ? []
    : serversOf(parsed.mcp_servers, { type: "app", app: "codex" }, APP_LABELS.codex, undefined);
});

/**
 * Every stdio server set up in the other apps, plus each project's `.mcp.json`. A server found
 * in several places is listed once per place, since each may differ.
 */
export const readImportableServers = Effect.fn("LocalConnectorImport.read")(function* (input: {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly appData: string | undefined;
  readonly projectFolders: ReadonlyArray<string>;
}) {
  const found = yield* Effect.all(
    [
      jsonServers(
        claudeDesktopSettings(input.home, input.platform, input.appData),
        { type: "app", app: "claude-desktop" },
        APP_LABELS["claude-desktop"],
        undefined,
      ),
      claudeCodeServers(input.home),
      codexServers(input.home),
      jsonServers(
        NodePath.join(input.home, ".cursor", "mcp.json"),
        { type: "app", app: "cursor" },
        APP_LABELS.cursor,
        undefined,
      ),
      ...input.projectFolders.map((folder) => folderServers(folder)),
    ],
    { concurrency: "unbounded" },
  );
  return found.flat();
});

/** The servers in a folder's `.mcp.json`, run in that folder. */
export const folderServers = (folder: string) =>
  jsonServers(
    NodePath.join(folder, ".mcp.json"),
    { type: "file", path: folder },
    NodePath.basename(folder),
    folder,
  );

export const sameSource = (a: LocalImportSource, b: LocalImportSource) =>
  a.type === "app"
    ? b.type === "app" && a.app === b.app && a.folder === b.folder
    : b.type === "file" && a.path === b.path;

export const importableSummary = (server: ImportedServer): LocalImportableServer => ({
  source: server.source,
  sourceLabel: server.sourceLabel,
  name: server.name,
  commandLine: commandLineOf({ command: server.command, args: maskedArgs(server.args) }),
  keys: Object.keys(server.env).filter(looksLikeKey),
});
