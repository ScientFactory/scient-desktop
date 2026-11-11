// @effect-diagnostics nodeBuiltinImport:off -- npm and uv write a package's files into a folder.
/**
 * A package connector (`npx -y pkg@1.2.3`, `uvx pkg==1.2.3`) brought into a folder an agent can
 * edit: the package's own files in `package/`, its dependencies installed beside them by the same
 * tool that runs it (npm, uv), and a manifest that runs it from the folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { ExtensionsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { agentProcessEnvironment } from "../../../provider/agentProcessEnvironment.ts";
import { oneLine } from "./agentStatus.ts";
import { type BundleManifest, writeFolderManifest } from "./LocalConnectorBundle.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const FETCH_TIMEOUT_MS = 5 * 60_000;
/** Where the package's own files go in the folder. */
const PACKAGE_DIR = "package";

const unsupported = (message: string) => new ExtensionsError({ reason: "unsupported", message });

export interface RunnerPackage {
  readonly runner: "npx" | "uvx";
  readonly identifier: string;
  /** As the command gave it: an exact version, an npm range or tag, or none (the latest). */
  readonly version: string | undefined;
  /** PyPI extras (`pkg[cli]`), whose dependencies come too. */
  readonly extras: ReadonlyArray<string>;
  /** Arguments after the package, as the registry declared them. */
  readonly rest: ReadonlyArray<string>;
}

/** Runner options before the package that change nothing about which code runs. */
const RUNNER_FLAGS = {
  npx: new Set(["-y", "--yes", "-q", "--quiet"]),
  uvx: new Set(["-q", "--quiet"]),
} as const;
/** `name`, `name[extra,…]`, then nothing or `==version`. */
const PYPI_SPEC =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[([^\]]*)\])?(?:==([^\s;,=<>!~]+))?$/u;

/** `npx`, `npx.cmd`, `/usr/local/bin/uvx`, `uvx.exe` … as the runner they are. */
const runnerOf = (command: string) => {
  const base = (command.split(/[\\/]/u).pop() ?? "")
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/u, "");
  return base === "npx" || base === "uvx" ? base : undefined;
};

/**
 * The package an `npx` or `uvx` manifest runs, a plain reason when Scient can't bring that form
 * in, or undefined when the manifest runs no package.
 */
export const packageOf = (
  manifest: BundleManifest,
): RunnerPackage | { readonly problem: string } | undefined => {
  const config = manifest.server.mcp_config;
  const runner = config?.command === undefined ? undefined : runnerOf(config.command);
  if (runner === undefined) return undefined;
  const args = config?.args ?? [];
  let at = 0;
  while (at < args.length && RUNNER_FLAGS[runner].has(args[at]!)) at += 1;
  const spec = args[at];
  const shown = [runner, ...args].join(" ");
  if (spec === undefined || spec.startsWith("-"))
    return {
      problem: `it runs \`${shown}\`; Scient brings in the code of \`${runner} <package>\` with no other ${runner} options.`,
    };
  const rest = args.slice(at + 1);
  if (runner === "npx") {
    const versionAt = spec.lastIndexOf("@");
    return versionAt > 0
      ? {
          runner,
          identifier: spec.slice(0, versionAt),
          version: spec.slice(versionAt + 1),
          extras: [],
          rest,
        }
      : { runner, identifier: spec, version: undefined, extras: [], rest };
  }
  const parsed = PYPI_SPEC.exec(spec);
  if (parsed === null)
    return {
      problem: `it runs the package \`${spec}\`; Scient reads a PyPI package as \`name\` or \`name==1.2.3\`.`,
    };
  return {
    runner,
    identifier: parsed[1]!,
    version: parsed[3],
    extras: (parsed[2] ?? "")
      .split(",")
      .map((extra) => extra.trim())
      .filter((extra) => extra !== ""),
    rest,
  };
};

/** Runs npm or uv as the user's agents would; says plainly when it is not installed. */
export type RunTool = (
  tool: "npm" | "uv",
  args: ReadonlyArray<string>,
) => Effect.Effect<void, ExtensionsError>;

const run = Effect.fn("PackageSource.runTool")(function* (
  tool: "npm" | "uv",
  args: ReadonlyArray<string>,
) {
  const env = agentProcessEnvironment({
    baseEnv: yield* HostProcess.Environment,
    platform: yield* HostProcess.Platform,
  });
  if ((yield* resolveCommandPath(tool, { env })) === null)
    return yield* unsupported(
      tool === "npm"
        ? "Bringing in this connector's code needs npm (it comes with Node.js) on this computer."
        : "Bringing in this connector's code needs uv (docs.astral.sh/uv) on this computer.",
    );
  const spawn = yield* resolveSpawnCommand(tool, args, { env });
  yield* Effect.tryPromise({
    try: () =>
      execFile(spawn.command, spawn.args, {
        shell: spawn.shell,
        env,
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }),
    catch: (error) => {
      const stderr = (error as { stderr?: unknown }).stderr;
      return unsupported(
        `${tool} could not fetch the package: ${oneLine(typeof stderr === "string" && stderr.trim() !== "" ? stderr : String(error))}`,
      );
    },
  });
});

/** npm and uv found the way local connectors' runtimes are found. */
export const makeRunTool = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runTool: RunTool = (tool, args) =>
    run(tool, args).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  return runTool;
});

const decodePackageJson = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
/** A double-quoted string, the same in TOML and Python. */
const quoted = (text: string) => `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

const entriesOf = (folder: string) => NodeFSP.readdir(folder).catch(() => [] as string[]);

/** Moves every entry of `from` into `to`, keeping what `to` already has. */
const moveInto = async (from: string, to: string, skip: ReadonlySet<string> = new Set()) => {
  await NodeFSP.mkdir(to, { recursive: true });
  for (const name of await entriesOf(from)) {
    if (skip.has(name) || (await entriesOf(to)).includes(name)) continue;
    await NodeFSP.rename(NodePath.join(from, name), NodePath.join(to, name));
  }
};

const BinField = (pkg: Record<string, unknown>, identifier: string): string | undefined => {
  const bin = pkg.bin;
  if (typeof bin === "string") return bin;
  if (bin !== null && typeof bin === "object") {
    const commands = bin as Record<string, unknown>;
    const own = commands[identifier.split("/").pop() ?? identifier];
    const first = typeof own === "string" ? own : Object.values(commands)[0];
    if (typeof first === "string") return first;
  }
  return typeof pkg.main === "string" ? pkg.main : undefined;
};

/** What a fetch made: where the program starts, and the exact version it brought in. */
interface Fetched {
  readonly entry: string;
  readonly version: string;
}

const NO_PROGRAM = "no program";

/** Plain words for a failed fetch: no program to start, or what went wrong. */
const fetchFailure = (pkg: RunnerPackage, tool: string) => (error: unknown) =>
  unsupported(
    error instanceof Error && error.message === NO_PROGRAM
      ? `${pkg.identifier} has no program ${tool} can start.`
      : `Scient could not bring in ${pkg.identifier}'s code: ${oneLine(error instanceof Error ? error.message : String(error))}`,
  );

/**
 * A work folder beside `folder`, removed afterwards: npm and uv write there, so moving their files
 * in is a rename on the same drive (a system temp folder may be on another).
 */
const besides = <A>(
  folder: string,
  use: (work: string) => Effect.Effect<A, ExtensionsError>,
): Effect.Effect<A, ExtensionsError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(folder), ".scient-package-")),
      catch: (error) =>
        unsupported(`Scient could not make a work folder: ${oneLine(String(error))}`),
    }),
    use,
    (work) => Effect.promise(() => NodeFSP.rm(work, { recursive: true, force: true })),
  );

/** npm installs the package and its dependencies; the package moves to `package/`. */
const fetchNpm = (pkg: RunnerPackage, folder: string, run: RunTool) =>
  besides(folder, (work) =>
    Effect.gen(function* () {
      yield* run("npm", [
        "install",
        "--prefix",
        work,
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--loglevel=error",
        pkg.version === undefined ? pkg.identifier : `${pkg.identifier}@${pkg.version}`,
      ]);
      return yield* Effect.tryPromise({
        try: async (): Promise<Fetched> => {
          const modules = NodePath.join(work, "node_modules");
          const own = NodePath.join(modules, ...pkg.identifier.split("/"));
          const decoded = decodePackageJson(
            await NodeFSP.readFile(NodePath.join(own, "package.json"), "utf8"),
          );
          const entry =
            decoded._tag === "Success" ? BinField(decoded.value, pkg.identifier) : undefined;
          if (entry === undefined) throw new Error(NO_PROGRAM);
          const version = decoded._tag === "Success" ? decoded.value.version : undefined;
          await moveInto(own, NodePath.join(folder, PACKAGE_DIR));
          await NodeFSP.rm(own, { recursive: true, force: true });
          await moveInto(modules, NodePath.join(folder, "node_modules"), new Set([".bin"]));
          return {
            entry: NodePath.posix.join(PACKAGE_DIR, entry.replace(/^\.\//u, "")),
            version: typeof version === "string" ? version : (pkg.version ?? "latest"),
          };
        },
        catch: fetchFailure(pkg, "npm"),
      });
    }),
  );

const metadataLines = (text: string, field: string) =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${field}: `))
    .map((line) => line.slice(field.length + 2).trim());

/** PEP 503 / 685 name: lower case, runs of `-_.` as one `-`. */
const normalizedName = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");

/**
 * A `Requires-Dist` line as a dependency of the project: kept when it needs no extra, or one of
 * `extras` (that clause dropped, since the folder's project has no extras); else undefined.
 */
const dependencyFor = (requirement: string, extras: ReadonlySet<string>) => {
  const [spec, marker] = requirement.split(/;(.*)/su);
  if (marker === undefined || !/\bextra\s*==/u.test(marker)) return requirement;
  const clause = /^\s*(?:(.*?)\s+and\s+)?extra\s*==\s*(['"])([^'"]+)\2\s*$/u.exec(marker);
  if (clause === null || !extras.has(normalizedName(clause[3]!))) return undefined;
  return clause[1] === undefined ? spec!.trim() : `${spec!.trim()}; ${clause[1].trim()}`;
};

/** uv installs the package's files; its dependencies go in `pyproject.toml` for `uv run`. */
const fetchPypi = (pkg: RunnerPackage, folder: string, name: string, run: RunTool) =>
  besides(folder, (work) =>
    Effect.gen(function* () {
      const extras = pkg.extras.length === 0 ? "" : `[${pkg.extras.join(",")}]`;
      yield* run("uv", [
        "pip",
        "install",
        "--quiet",
        "--no-deps",
        "--target",
        work,
        `${pkg.identifier}${extras}${pkg.version === undefined ? "" : `==${pkg.version}`}`,
      ]);
      return yield* Effect.tryPromise({
        try: async (): Promise<Fetched> => {
          const info = (await entriesOf(work)).find((item) => item.endsWith(".dist-info"));
          if (info === undefined) throw new Error(NO_PROGRAM);
          const read = (file: string) =>
            NodeFSP.readFile(NodePath.join(work, info, file), "utf8").catch(() => "");
          const metadata = await read("METADATA");
          const scripts = (await read("entry_points.txt"))
            .split(/\[console_scripts\]/u)[1]
            ?.split(/^\[/mu)[0]
            ?.split(/\r?\n/u)
            .map((line) => /^\s*([^=\s]+)\s*=\s*([\w.]+):([\w.]+)/u.exec(line))
            .filter((match) => match !== null);
          const script =
            scripts?.find((match) => match[1] === pkg.identifier) ?? scripts?.[0] ?? undefined;
          if (script === undefined) throw new Error(NO_PROGRAM);
          const wanted = new Set(pkg.extras.map(normalizedName));
          const dependencies = metadataLines(metadata, "Requires-Dist").flatMap(
            (requirement) => dependencyFor(requirement, wanted) ?? [],
          );
          const python = metadataLines(metadata, "Requires-Python")[0] ?? ">=3.10";
          await moveInto(work, NodePath.join(folder, PACKAGE_DIR), new Set(["bin"]));
          const project = normalizedName(name)
            .replace(/[^a-z0-9-]+/gu, "-")
            .replace(/^-+|-+$/gu, "");
          await NodeFSP.writeFile(
            NodePath.join(folder, "pyproject.toml"),
            [
              "[project]",
              `name = ${quoted(`${project || "package"}-connector`)}`,
              'version = "0"',
              `requires-python = ${quoted(python)}`,
              `dependencies = [${dependencies.map(quoted).join(", ")}]`,
              "",
              "[tool.uv]",
              "package = false",
              "",
            ].join("\n"),
          );
          // An entry point may name an attribute inside the module (`mod:app.main`).
          await NodeFSP.writeFile(
            NodePath.join(folder, "server.py"),
            [
              "import importlib, pathlib, sys",
              `sys.path.insert(0, str(pathlib.Path(__file__).parent / ${quoted(PACKAGE_DIR)}))`,
              `target = importlib.import_module(${quoted(script[2]!)})`,
              `for name in ${quoted(script[3]!)}.split("."):`,
              "    target = getattr(target, name)",
              "sys.exit(target())",
              "",
            ].join("\n"),
          );
          return {
            entry: "server.py",
            version: metadataLines(metadata, "Version")[0] ?? pkg.version ?? "latest",
          };
        },
        catch: fetchFailure(pkg, "uv"),
      });
    }),
  );

/** The manifest, now running the package from its folder with the same arguments and setup. */
const vendoredManifest = (
  manifest: BundleManifest,
  pkg: RunnerPackage,
  entry: string,
): BundleManifest => {
  const env = manifest.server.mcp_config?.env;
  const file = `\${__dirname}/${entry}`;
  return {
    ...manifest,
    server: {
      ...manifest.server,
      type: pkg.runner === "npx" ? "node" : "uv",
      entry_point: entry,
      mcp_config: {
        ...(pkg.runner === "npx"
          ? { command: "node", args: [file, ...pkg.rest] }
          : { command: "uv", args: ["run", "--project", "${__dirname}", file, ...pkg.rest] }),
        ...(env === undefined ? {} : { env }),
      },
    },
  };
};

/**
 * Brings a package connector's code into `folder` (which holds its generated manifest) and
 * rewrites the manifest to run it from there. Returns where the editable code is, for the agent.
 */
export const bringInPackage = Effect.fn("PackageSource.bringIn")(function* (
  folder: string,
  manifest: BundleManifest,
  pkg: RunnerPackage,
  run: RunTool,
) {
  const { entry, version } =
    pkg.runner === "npx"
      ? yield* fetchNpm(pkg, folder, run)
      : yield* fetchPypi(pkg, folder, manifest.name, run);
  yield* writeFolderManifest(folder, vendoredManifest(manifest, pkg, entry), { replace: true });
  const what = `${pkg.identifier} ${version}`;
  return pkg.runner === "npx"
    ? `The code of ${what} is in ${PACKAGE_DIR}/ (it starts at ${entry}); edit it there. Its dependencies are in node_modules/. manifest.json now runs it from this folder.`
    : `The code of ${what} is in ${PACKAGE_DIR}/; edit it there. server.py starts it, and uv installs the dependencies in pyproject.toml into .venv/ when it starts. manifest.json now runs it from this folder.`;
});
