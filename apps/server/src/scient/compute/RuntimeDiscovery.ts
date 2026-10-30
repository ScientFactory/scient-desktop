// @effect-diagnostics nodeBuiltinImport:off -- discovery reads host filesystem metadata only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ComputeRuntimeSource } from "@scientfactory/compute";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Filesystem metadata discovery reads. Nothing here launches a runtime; Windows
 * Python registrations are the one bounded `reg.exe` read, done asynchronously.
 */
export interface RuntimeDiscoveryHost {
  /** Follows links. */
  readonly kind: (path: string) => "file" | "directory" | null;
  /** A link whose target no longer exists. */
  readonly isDanglingLink: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
  readonly readDirectory: (path: string) => ReadonlyArray<string>;
  /** Small text files only; null when absent or unreadable. */
  readonly readText: (path: string) => string | null;
  readonly realPath: (path: string) => string | null;
  /** PEP 514 executables; empty off Windows. */
  readonly windowsPythonRegistrations: () => Promise<ReadonlyArray<string>>;
}

const MAX_TEXT_BYTES = 64 * 1024;
/** Directories such as conda `envs` or pyenv `versions` are read at most this far. */
const MAX_DIRECTORY_ENTRIES = 64;
const MAX_DISCOVERED_RUNTIMES = 48;

function nodeKind(path: string): "file" | "directory" | null {
  try {
    const stat = NodeFS.statSync(path);
    return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
  } catch {
    return null;
  }
}

const REG_KEYS = [
  "HKCU\\Software\\Python",
  "HKLM\\Software\\Python",
  "HKLM\\Software\\WOW6432Node\\Python",
];

/** Reads `reg query /s` output: ExecutablePath values, else InstallPath defaults plus python.exe. */
export function parseWindowsPythonRegistry(output: string): ReadonlyArray<string> {
  const found: string[] = [];
  let key = "";
  let installPath: string | null = null;
  let executable: string | null = null;
  const flush = () => {
    const path =
      executable ?? (installPath === null ? null : NodePath.win32.join(installPath, "python.exe"));
    if (path !== null && !found.includes(path)) found.push(path);
    installPath = null;
    executable = null;
  };
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^HKEY_/u.test(line)) {
      if (/\\InstallPath$/iu.test(key)) flush();
      key = line;
      continue;
    }
    if (!/\\InstallPath$/iu.test(key)) continue;
    const value = /^(\S.*?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/u.exec(line);
    if (value === null) continue;
    if (value[1] === "ExecutablePath") executable = value[2]!.trim();
    else if (value[1] === "(Default)") installPath = value[2]!.trim();
  }
  if (/\\InstallPath$/iu.test(key)) flush();
  return found;
}

let registrations: Promise<ReadonlyArray<string>> | null = null;

function readWindowsRegistrations(): Promise<ReadonlyArray<string>> {
  registrations ??= Promise.all(
    REG_KEYS.map(
      (key) =>
        new Promise<string>((resolve) => {
          NodeChildProcess.execFile(
            "reg.exe",
            ["query", key, "/s"],
            { timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout) => resolve(error === null ? stdout : ""),
          );
        }),
    ),
  ).then((outputs) => [...new Set(outputs.flatMap(parseWindowsPythonRegistry))]);
  return registrations;
}

const makeNodeRuntimeDiscoveryHost = (platform: NodeJS.Platform): RuntimeDiscoveryHost => ({
  kind: nodeKind,
  isDanglingLink: (path) => {
    try {
      return NodeFS.lstatSync(path).isSymbolicLink() && nodeKind(path) === null;
    } catch {
      return false;
    }
  },
  isExecutable: (path) => {
    if (nodeKind(path) !== "file") return false;
    if (platform === "win32") return true;
    try {
      NodeFS.accessSync(path, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readDirectory: (path) => {
    try {
      return NodeFS.readdirSync(path).slice(0, 4096);
    } catch {
      return [];
    }
  },
  readText: (path) => {
    try {
      const stat = NodeFS.statSync(path);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  realPath: (path) => {
    try {
      return NodeFS.realpathSync(path);
    } catch {
      return null;
    }
  },
  windowsPythonRegistrations: () =>
    platform === "win32" ? readWindowsRegistrations() : Promise.resolve([]),
});

/** Null means the host's real filesystem; tests provide a fake. */
export const RuntimeDiscoveryHostReference = Context.Reference<RuntimeDiscoveryHost | null>(
  "t3/scient/compute/RuntimeDiscoveryHost",
  { defaultValue: () => null },
);

/** A runtime found on disk, before anything was launched. */
export interface DiscoveredRuntime {
  readonly executable: string;
  readonly source: ComputeRuntimeSource;
  /** Where it came from, as a user knows it: "conda: analysis", "pyenv", "Homebrew". */
  readonly origin: string | null;
  /** Known without launching: a broken environment or a Store shortcut. */
  readonly problem: string | null;
}

export interface DiscoveryContext {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly host: RuntimeDiscoveryHost;
}

export const discoveryContext = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const host = (yield* RuntimeDiscoveryHostReference) ?? makeNodeRuntimeDiscoveryHost(platform);
  return {
    platform,
    environment,
    homeDirectory: environment.HOME ?? environment.USERPROFILE ?? homeDirectory,
    host,
  } satisfies DiscoveryContext;
});

function pathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function environmentPath(context: DiscoveryContext): ReadonlyArray<string> {
  const value =
    context.platform === "win32"
      ? (context.environment.Path ?? context.environment.PATH)
      : context.environment.PATH;
  return (value ?? "")
    .split(context.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((entry) => entry.length > 0);
}

/** Every PATH match, in PATH order. */
export function pathMatches(context: DiscoveryContext, names: ReadonlyArray<string>) {
  const path = pathModule(context.platform);
  return environmentPath(context).flatMap((directory) =>
    names.map((name) => path.join(directory, name)).filter(context.host.isExecutable),
  );
}

/** Newest-first entries of `directory` matching `pattern`, bounded. */
function versionedEntries(
  context: DiscoveryContext,
  directory: string,
  pattern: RegExp,
): ReadonlyArray<string> {
  return context.host
    .readDirectory(directory)
    .filter((entry) => pattern.test(entry))
    .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((entry) => pathModule(context.platform).join(directory, entry));
}

function identity(context: DiscoveryContext, executable: string, keepPath: boolean): string {
  const resolved = keepPath ? executable : (context.host.realPath(executable) ?? executable);
  return context.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * First occurrence wins, so precedence is the caller's order. Virtual environments keep their own
 * path as identity: resolving their interpreter link would collapse them into the base Python.
 */
function dedupeRuntimes(
  context: DiscoveryContext,
  runtimes: ReadonlyArray<DiscoveredRuntime>,
  isEnvironment: (executable: string) => boolean = () => false,
): ReadonlyArray<DiscoveredRuntime> {
  const seen = new Set<string>();
  const result: DiscoveredRuntime[] = [];
  for (const runtime of runtimes) {
    const key = identity(
      context,
      runtime.executable,
      runtime.problem !== null || isEnvironment(runtime.executable),
    );
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(runtime);
    if (result.length >= MAX_DISCOVERED_RUNTIMES) break;
  }
  return result;
}

// Python

function pythonInPrefix(context: DiscoveryContext, prefix: string, venv: boolean): string {
  const path = pathModule(context.platform);
  if (context.platform !== "win32") return path.join(prefix, "bin", "python");
  return venv ? path.join(prefix, "Scripts", "python.exe") : path.join(prefix, "python.exe");
}

/** `home` from pyvenv.cfg: the directory of the Python this environment was made from. */
function readPyvenvHome(context: DiscoveryContext, prefix: string): string | null {
  const text = context.host.readText(pathModule(context.platform).join(prefix, "pyvenv.cfg"));
  if (text === null) return null;
  const line = text.split(/\r?\n/u).find((candidate) => /^\s*home\s*=/u.test(candidate));
  return line === undefined ? null : line.replace(/^\s*home\s*=\s*/u, "").trim() || null;
}

/** Why a virtual environment cannot run, read from its files without launching it. */
function virtualEnvironmentProblem(context: DiscoveryContext, prefix: string): string | null {
  const executable = pythonInPrefix(context, prefix, true);
  const home = readPyvenvHome(context, prefix);
  if (home !== null && context.host.kind(home) !== "directory")
    return `Its base Python at ${home} is gone. Recreate the environment.`;
  if (!context.host.isExecutable(executable))
    return context.host.isDanglingLink(executable) || home !== null
      ? "Its Python is missing. Recreate the environment."
      : null;
  return null;
}

function isVirtualEnvironmentExecutable(context: DiscoveryContext, executable: string): boolean {
  const path = pathModule(context.platform);
  return (
    context.host.kind(path.join(path.dirname(path.dirname(executable)), "pyvenv.cfg")) === "file"
  );
}

function venvRuntime(
  context: DiscoveryContext,
  prefix: string,
  source: ComputeRuntimeSource,
  origin: string,
): DiscoveredRuntime | null {
  const path = pathModule(context.platform);
  const executable = pythonInPrefix(context, prefix, true);
  const present =
    context.host.kind(path.join(prefix, "pyvenv.cfg")) === "file" ||
    context.host.isExecutable(executable) ||
    context.host.isDanglingLink(executable);
  if (!present) return null;
  return { executable, source, origin, problem: virtualEnvironmentProblem(context, prefix) };
}

function condaRuntime(
  context: DiscoveryContext,
  prefix: string,
  source: ComputeRuntimeSource,
  origin: string,
): DiscoveredRuntime | null {
  const path = pathModule(context.platform);
  if (context.host.kind(path.join(prefix, "conda-meta")) !== "directory") return null;
  const executable = pythonInPrefix(context, prefix, false);
  // An environment holding only R or other tools has no Python and is not a Python candidate.
  if (!context.host.isExecutable(executable)) return null;
  return { executable, source, origin, problem: null };
}

function projectPythons(context: DiscoveryContext, projectRoot: string) {
  const path = pathModule(context.platform);
  const pixi = path.join(projectRoot, ".pixi", "envs");
  const pixiEnvironments = context.host
    .readDirectory(pixi)
    .toSorted((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)))
    .slice(0, MAX_DIRECTORY_ENTRIES);
  return [
    venvRuntime(context, path.join(projectRoot, ".venv"), "project", ".venv"),
    condaRuntime(context, path.join(projectRoot, ".conda"), "project", ".conda"),
    ...pixiEnvironments.map((name) =>
      condaRuntime(context, path.join(pixi, name), "project", `pixi: ${name}`),
    ),
  ].filter((runtime): runtime is DiscoveredRuntime => runtime !== null);
}

const WINDOWS_STORE_ALIAS =
  "This is the Microsoft Store shortcut, not an installed Python. Install Python or choose another.";

/**
 * Store aliases for an installed Store Python work; the App Installer stubs open the Store. Without
 * reading reparse data, a Store Python package is the evidence that the aliases are real.
 */
function windowsAliasProblem(context: DiscoveryContext, executable: string): string | null {
  if (!/\\Microsoft\\WindowsApps\\[^\\]+$/iu.test(executable)) return null;
  const local = context.environment.LOCALAPPDATA;
  const packages =
    local === undefined ? [] : context.host.readDirectory(NodePath.win32.join(local, "Packages"));
  return packages.some((entry) => /^PythonSoftwareFoundation\.Python\./iu.test(entry))
    ? null
    : WINDOWS_STORE_ALIAS;
}

/** macOS `/usr/bin/python3` asks to install developer tools when they are absent. */
const MACOS_PYTHON_SHIM = "/usr/bin/python3";
const MACOS_DEVELOPER_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";

function condaRoots(context: DiscoveryContext): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const home = context.homeDirectory;
  const names = [
    "miniconda3",
    "anaconda3",
    "miniforge3",
    "mambaforge",
    "micromamba",
    ".micromamba",
  ];
  const fromExe = env.CONDA_EXE === undefined ? [] : [path.dirname(path.dirname(env.CONDA_EXE))];
  const shared =
    context.platform === "win32"
      ? [
          ...(env.LOCALAPPDATA === undefined
            ? []
            : names.map((name) => path.join(env.LOCALAPPDATA!, name))),
          ...names.map((name) => path.join(env.ProgramData ?? "C:\\ProgramData", name)),
        ]
      : [
          path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "mamba"),
          ...names.map((name) => path.join("/opt", name)),
          "/opt/conda",
          ...(context.platform === "darwin"
            ? ["/opt/homebrew/Caskroom", "/usr/local/Caskroom"].flatMap((cask) =>
                ["miniconda", "miniforge", "anaconda", "mambaforge"].map((name) =>
                  path.join(cask, name, "base"),
                ),
              )
            : []),
        ];
  return [
    ...fromExe,
    ...(env.MAMBA_ROOT_PREFIX === undefined ? [] : [env.MAMBA_ROOT_PREFIX]),
    ...names.map((name) => path.join(home, name)),
    ...shared,
  ];
}

function condaPythons(context: DiscoveryContext): ReadonlyArray<DiscoveredRuntime> {
  const path = pathModule(context.platform);
  const listed = (
    context.host.readText(path.join(context.homeDirectory, ".conda", "environments.txt")) ?? ""
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, MAX_DIRECTORY_ENTRIES);
  const prefixes = condaRoots(context).flatMap((root) => [
    root,
    ...context.host
      .readDirectory(path.join(root, "envs"))
      .toSorted()
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((name) => path.join(root, "envs", name)),
  ]);
  return [...prefixes, ...listed]
    .map((prefix) =>
      condaRuntime(
        context,
        prefix,
        "conventional",
        `conda: ${path.basename(path.dirname(prefix)) === "envs" ? path.basename(prefix) : "base"}`,
      ),
    )
    .filter((runtime): runtime is DiscoveredRuntime => runtime !== null);
}

function managerPythons(context: DiscoveryContext): ReadonlyArray<DiscoveredRuntime> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const home = context.homeDirectory;
  const windows = context.platform === "win32";
  const data = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const unix = (root: string, origin: string, relative = path.join("bin", "python")) =>
    versionedEntries(context, root, /^\d/u).map((prefix) => ({
      executable: path.join(prefix, relative),
      origin,
    }));
  const roots: ReadonlyArray<{ readonly executable: string; readonly origin: string }> = windows
    ? [
        ...unix(
          path.join(env.PYENV_ROOT ?? path.join(home, ".pyenv", "pyenv-win"), "versions"),
          "pyenv",
          "python.exe",
        ),
        ...(env.LOCALAPPDATA === undefined && env.MISE_DATA_DIR === undefined
          ? []
          : unix(
              path.join(
                env.MISE_DATA_DIR ?? path.join(env.LOCALAPPDATA!, "mise"),
                "installs",
                "python",
              ),
              "mise",
              "python.exe",
            )),
        ...(env.APPDATA === undefined && env.UV_PYTHON_INSTALL_DIR === undefined
          ? []
          : versionedEntries(
              context,
              env.UV_PYTHON_INSTALL_DIR ?? path.join(env.APPDATA!, "uv", "python"),
              /^c?python-/iu,
            ).map((prefix) => ({ executable: path.join(prefix, "python.exe"), origin: "uv" }))),
      ]
    : [
        ...unix(path.join(env.PYENV_ROOT ?? path.join(home, ".pyenv"), "versions"), "pyenv"),
        ...unix(
          path.join(env.ASDF_DATA_DIR ?? path.join(home, ".asdf"), "installs", "python"),
          "asdf",
        ),
        ...unix(
          path.join(env.MISE_DATA_DIR ?? path.join(data, "mise"), "installs", "python"),
          "mise",
        ),
        ...versionedEntries(
          context,
          env.UV_PYTHON_INSTALL_DIR ?? path.join(data, "uv", "python"),
          /^c?python-/iu,
        ).map((prefix) => ({ executable: path.join(prefix, "bin", "python3"), origin: "uv" })),
      ];
  return roots
    .filter((root) => context.host.isExecutable(root.executable))
    .map((root) => ({ ...root, source: "conventional" as const, problem: null }));
}

function systemPythons(
  context: DiscoveryContext,
  registrations: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredRuntime> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const entries = (items: ReadonlyArray<string>, origin: string) =>
    items.map((executable) => ({ executable, origin }));
  const list: ReadonlyArray<{ readonly executable: string; readonly origin: string }> =
    context.platform === "win32"
      ? [
          ...entries(registrations, "Python launcher"),
          ...(env.LOCALAPPDATA === undefined
            ? []
            : entries(
                versionedEntries(
                  context,
                  path.join(env.LOCALAPPDATA, "Programs", "Python"),
                  /^Python3/iu,
                ).map((prefix) => path.join(prefix, "python.exe")),
                "python.org",
              )),
          ...entries(
            [env.ProgramFiles, env["ProgramFiles(x86)"]]
              .filter((root): root is string => root !== undefined)
              .flatMap((root) => versionedEntries(context, root, /^Python3/iu))
              .map((prefix) => path.join(prefix, "python.exe")),
            "python.org",
          ),
        ]
      : context.platform === "darwin"
        ? [
            ...entries(["/opt/homebrew/bin/python3", "/usr/local/bin/python3"], "Homebrew"),
            ...entries(
              ["/opt/homebrew/opt", "/usr/local/opt"].flatMap((root) =>
                versionedEntries(context, root, /^python@3/u).map((prefix) =>
                  path.join(prefix, "bin", "python3"),
                ),
              ),
              "Homebrew",
            ),
            ...entries(
              versionedEntries(
                context,
                "/Library/Frameworks/Python.framework/Versions",
                /^\d/u,
              ).map((prefix) => path.join(prefix, "bin", "python3")),
              "python.org",
            ),
            ...entries([MACOS_DEVELOPER_PYTHON], "Apple developer tools"),
          ]
        : [
            ...entries(
              [
                "/home/linuxbrew/.linuxbrew/bin/python3",
                path.join(context.homeDirectory, ".linuxbrew", "bin", "python3"),
              ],
              "Homebrew",
            ),
            ...entries(["/usr/local/bin/python3", "/usr/bin/python3"], "System"),
          ];
  return list
    .filter((entry) => context.host.isExecutable(entry.executable))
    .map((entry) => ({ ...entry, source: "conventional" as const, problem: null }));
}

/**
 * Every Python this host can see, in Automatic's preference order: the project's own environments,
 * an activated environment, PATH, then version managers, conda and conventional installs.
 */
export function enumeratePythonRuntimes(
  context: DiscoveryContext,
  input: {
    readonly projectRoot: string | null;
    readonly windowsRegistrations: ReadonlyArray<string>;
  },
): ReadonlyArray<DiscoveredRuntime> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const active = [
    env.VIRTUAL_ENV === undefined
      ? null
      : venvRuntime(context, env.VIRTUAL_ENV, "conventional", "active environment"),
    env.CONDA_PREFIX === undefined
      ? null
      : condaRuntime(
          context,
          env.CONDA_PREFIX,
          "conventional",
          `conda: ${path.basename(env.CONDA_PREFIX)}`,
        ),
  ].filter((runtime): runtime is DiscoveredRuntime => runtime !== null);
  const shimOnly =
    context.platform === "darwin" && !context.host.isExecutable(MACOS_DEVELOPER_PYTHON);
  const onPath = pathMatches(
    context,
    context.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"],
  )
    .filter((executable) => !shimOnly || executable !== MACOS_PYTHON_SHIM)
    .map((executable) => ({
      executable,
      source: "path" as const,
      origin: null,
      problem: context.platform === "win32" ? windowsAliasProblem(context, executable) : null,
    }));
  return dedupeRuntimes(
    context,
    [
      ...(input.projectRoot === null ? [] : projectPythons(context, input.projectRoot)),
      ...active,
      ...onPath,
      ...managerPythons(context),
      ...condaPythons(context),
      ...systemPythons(context, input.windowsRegistrations),
    ],
    (executable) => isVirtualEnvironmentExecutable(context, executable),
  );
}
