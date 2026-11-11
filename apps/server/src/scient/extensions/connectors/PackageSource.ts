// @effect-diagnostics nodeBuiltinImport:off -- npm and uv write a package's files into a folder.
/**
 * A package connector (`npx -y pkg@1.2.3`, `uvx pkg==1.2.3`) brought into a folder an agent can
 * edit: the package's own files in `package/`, its dependencies installed beside them by the same
 * tool that runs it (npm, uv), and a manifest that runs it from the folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
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
  readonly version: string;
  /** Arguments after the package, as the registry declared them. */
  readonly rest: ReadonlyArray<string>;
}

/** The package a generated `npx -y pkg@1.2.3` or `uvx pkg==1.2.3` manifest runs. */
export const packageOf = (manifest: BundleManifest): RunnerPackage | undefined => {
  const config = manifest.server.mcp_config;
  const args = config?.args ?? [];
  if (config?.command === "npx" && args[0] === "-y" && args[1] !== undefined) {
    const at = args[1].lastIndexOf("@");
    if (at <= 0) return undefined;
    return {
      runner: "npx",
      identifier: args[1].slice(0, at),
      version: args[1].slice(at + 1),
      rest: args.slice(2),
    };
  }
  if (config?.command === "uvx" && args[0]?.includes("==")) {
    const [identifier, version] = args[0].split("==");
    if (!identifier || !version) return undefined;
    return { runner: "uvx", identifier, version, rest: args.slice(1) };
  }
  return undefined;
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

/** npm installs the package and its dependencies; the package moves to `package/`. */
const fetchNpm = Effect.fn("PackageSource.fetchNpm")(function* (
  pkg: RunnerPackage,
  folder: string,
  run: RunTool,
) {
  const work = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-npm-")),
  );
  return yield* Effect.gen(function* () {
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
      `${pkg.identifier}@${pkg.version}`,
    ]);
    return yield* Effect.tryPromise({
      try: async () => {
        const modules = NodePath.join(work, "node_modules");
        const own = NodePath.join(modules, ...pkg.identifier.split("/"));
        const decoded = decodePackageJson(
          await NodeFSP.readFile(NodePath.join(own, "package.json"), "utf8"),
        );
        const entry =
          decoded._tag === "Success" ? BinField(decoded.value, pkg.identifier) : undefined;
        if (entry === undefined) throw new Error("no entry");
        await moveInto(own, NodePath.join(folder, PACKAGE_DIR));
        await NodeFSP.rm(own, { recursive: true, force: true });
        await moveInto(modules, NodePath.join(folder, "node_modules"), new Set([".bin"]));
        return NodePath.posix.join(PACKAGE_DIR, entry.replace(/^\.\//u, ""));
      },
      catch: () => unsupported(`${pkg.identifier} has no program npm can start.`),
    });
  }).pipe(
    Effect.ensuring(Effect.promise(() => NodeFSP.rm(work, { recursive: true, force: true }))),
  );
});

const metadataLines = (text: string, field: string) =>
  text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${field}: `))
    .map((line) => line.slice(field.length + 2).trim());

/** uv installs the package's files; its dependencies go in `pyproject.toml` for `uv run`. */
const fetchPypi = Effect.fn("PackageSource.fetchPypi")(function* (
  pkg: RunnerPackage,
  folder: string,
  name: string,
  run: RunTool,
) {
  const work = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-uv-")),
  );
  return yield* Effect.gen(function* () {
    yield* run("uv", [
      "pip",
      "install",
      "--quiet",
      "--no-deps",
      "--target",
      work,
      `${pkg.identifier}==${pkg.version}`,
    ]);
    return yield* Effect.tryPromise({
      try: async () => {
        const info = (await entriesOf(work)).find((item) => item.endsWith(".dist-info"));
        if (info === undefined) throw new Error("no metadata");
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
        if (script === undefined) throw new Error("no script");
        const dependencies = metadataLines(metadata, "Requires-Dist").filter(
          (requirement) => !/;\s*.*\bextra\s*==/u.test(requirement),
        );
        const python = metadataLines(metadata, "Requires-Python")[0] ?? ">=3.10";
        await moveInto(work, NodePath.join(folder, PACKAGE_DIR), new Set(["bin"]));
        await NodeFSP.writeFile(
          NodePath.join(folder, "pyproject.toml"),
          [
            "[project]",
            `name = ${quoted(`${name}-connector`)}`,
            'version = "0"',
            `requires-python = ${quoted(python)}`,
            `dependencies = [${dependencies.map(quoted).join(", ")}]`,
            "",
            "[tool.uv]",
            "package = false",
            "",
          ].join("\n"),
        );
        await NodeFSP.writeFile(
          NodePath.join(folder, "server.py"),
          [
            "import pathlib, sys",
            `sys.path.insert(0, str(pathlib.Path(__file__).parent / ${quoted(PACKAGE_DIR)}))`,
            `from ${script[2]} import ${script[3]}`,
            `sys.exit(${script[3]}())`,
            "",
          ].join("\n"),
        );
        return "server.py";
      },
      catch: () => unsupported(`${pkg.identifier} has no program uv can start.`),
    });
  }).pipe(
    Effect.ensuring(Effect.promise(() => NodeFSP.rm(work, { recursive: true, force: true }))),
  );
});

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
  const entry =
    pkg.runner === "npx"
      ? yield* fetchNpm(pkg, folder, run)
      : yield* fetchPypi(pkg, folder, manifest.name, run);
  yield* writeFolderManifest(folder, vendoredManifest(manifest, pkg, entry), { replace: true });
  const what = `${pkg.identifier} ${pkg.version}`;
  return pkg.runner === "npx"
    ? `The code of ${what} is in ${PACKAGE_DIR}/ (it starts at ${entry}); edit it there. Its dependencies are in node_modules/. manifest.json now runs it from this folder.`
    : `The code of ${what} is in ${PACKAGE_DIR}/; edit it there. server.py starts it, and uv installs the dependencies in pyproject.toml into .venv/ when it starts. manifest.json now runs it from this folder.`;
});
