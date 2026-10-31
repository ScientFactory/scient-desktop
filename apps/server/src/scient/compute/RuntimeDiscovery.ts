// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- discovery reads host filesystem metadata only.
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
  readonly readDirectory: (path: string, limit?: number) => ReadonlyArray<string>;
  /** Small text files only; null when absent or unreadable. */
  readonly readText: (path: string) => string | null;
  readonly realPath: (path: string) => string | null;
  /** PEP 514 executables; empty off Windows. A refresh reads the registry again. */
  readonly windowsPythonRegistrations: (refresh?: boolean) => Promise<ReadonlyArray<string>>;
  /** Folders an installer recorded; empty off Windows. */
  readonly windowsInstallRoots: (application: "r" | "matlab") => Promise<ReadonlyArray<string>>;
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
export function parseWindowsPythonRegistry(
  output: string,
  environment: Readonly<Record<string, string | undefined>> = {},
): ReadonlyArray<string> {
  // REG_EXPAND_SZ values name variables such as %LOCALAPPDATA%.
  const expanded = (value: string) =>
    value.replace(/%([^%]+)%/gu, (match, name: string) => environment[name] ?? match);
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
    if (value[1] === "ExecutablePath") executable = expanded(value[2]!.trim());
    else if (value[1] === "(Default)") installPath = expanded(value[2]!.trim());
  }
  if (/\\InstallPath$/iu.test(key)) flush();
  return found;
}

/** Install folders written by the R and MATLAB installers. */
const INSTALL_ROOT_KEYS = {
  r: { keys: ["HKCU\\Software\\R-core\\R", "HKLM\\Software\\R-core\\R"], value: "InstallPath" },
  matlab: { keys: ["HKLM\\Software\\MathWorks\\MATLAB"], value: "MATLABROOT" },
} as const;

export function parseWindowsInstallRoots(output: string, value: string): ReadonlyArray<string> {
  const roots = output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/u.exec(line);
    return match?.[1] === value ? [match[2]!.trim()] : [];
  });
  return [...new Set(roots)];
}

function queryRegistry(key: string): Promise<string> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "reg.exe",
      ["query", key, "/s"],
      { timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : ""),
    );
  });
}

let registrations: Promise<ReadonlyArray<string>> | null = null;

function readWindowsRegistrations(
  environment: Readonly<Record<string, string | undefined>>,
  refresh: boolean,
): Promise<ReadonlyArray<string>> {
  if (refresh) registrations = null;
  registrations ??= Promise.all(REG_KEYS.map(queryRegistry)).then((outputs) => [
    ...new Set(outputs.flatMap((output) => parseWindowsPythonRegistry(output, environment))),
  ]);
  return registrations;
}

/** Folders that stopped answering, until a retry. Blocking calls here would stall the server. */
const quarantined = new Map<string, number>();

export function quarantineFolder(source: string, until: number): void {
  const folder = source.split("*", 1)[0]!;
  if (NodePath.isAbsolute(folder)) quarantined.set(folder, until);
}

function isQuarantined(path: string): boolean {
  for (const [folder, until] of quarantined) {
    if (until <= Date.now()) quarantined.delete(folder);
    else if (path === folder || path.startsWith(`${folder}${NodePath.sep}`)) return true;
  }
  return false;
}

export const makeNodeRuntimeDiscoveryHost = (
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeDiscoveryHost => ({
  kind: (path) => (isQuarantined(path) ? null : nodeKind(path)),
  isDanglingLink: (path) => {
    if (isQuarantined(path)) return false;
    try {
      return NodeFS.lstatSync(path).isSymbolicLink() && nodeKind(path) === null;
    } catch {
      return false;
    }
  },
  isExecutable: (path) => {
    if (isQuarantined(path) || nodeKind(path) !== "file") return false;
    if (platform === "win32") return true;
    try {
      NodeFS.accessSync(path, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readDirectory: (path, limit = 4096) => {
    if (isQuarantined(path)) return [];
    try {
      return NodeFS.readdirSync(path).slice(0, limit);
    } catch {
      return [];
    }
  },
  readText: (path) => {
    if (isQuarantined(path)) return null;
    try {
      const stat = NodeFS.statSync(path);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  realPath: (path) => {
    if (isQuarantined(path)) return null;
    try {
      return NodeFS.realpathSync(path);
    } catch {
      return null;
    }
  },
  windowsInstallRoots: async (application) => {
    if (platform !== "win32") return [];
    const { keys, value } = INSTALL_ROOT_KEYS[application];
    const outputs = await Promise.all(keys.map(queryRegistry));
    return parseWindowsInstallRoots(outputs.join("\n"), value);
  },
  windowsPythonRegistrations: (refresh = false) =>
    platform === "win32" ? readWindowsRegistrations(environment, refresh) : Promise.resolve([]),
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
  const host =
    (yield* RuntimeDiscoveryHostReference) ?? makeNodeRuntimeDiscoveryHost(platform, environment);
  return {
    platform,
    environment,
    homeDirectory: environment.HOME ?? environment.USERPROFILE ?? homeDirectory,
    host,
  } satisfies DiscoveryContext;
});

export function pathModule(platform: NodeJS.Platform) {
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

const ORIGINS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\/\.?conda[^/]*\/|\/(mini|ana)conda3\/|\/miniforge3\/|\/mambaforge\/|\/micromamba\//iu,
    "conda",
  ],
  [/\/Cellar\/|\/Caskroom\/|\/opt\/homebrew\/|\/linuxbrew\//u, "Homebrew"],
  [/\/Library\/Frameworks\/Python\.framework\//u, "python.org"],
  [/\/AppData\/Local\/Programs\/Python\//iu, "python.org"],
  [/\/Library\/Frameworks\/R\.framework\//u, "CRAN"],
  [/\/\.pyenv\//u, "pyenv"],
  [/\/\.asdf\//u, "asdf"],
  [/\/mise\/installs\//u, "mise"],
  [/\/uv\/(data\/)?python\//u, "uv"],
  [/\/\.juliaup\/|\/\.julia\/juliaup\//u, "juliaup"],
  [/\/\.rustup\/|\/\.cargo\/bin\//u, "rustup"],
  [/\/\.elan\//u, "elan"],
  [/\/\.nvm\//u, "nvm"],
  [/\/\.sdkman\//u, "SDKMAN"],
  [/\/\.opam\//u, "opam"],
  [/\/\.ghcup\//u, "GHCup"],
  [/\/\.pixi\//u, "pixi"],
  [/\/nix\/store\//u, "Nix"],
  [/\/Library\/Developer\/CommandLineTools\/|\/Xcode[^/]*\.app\//u, "Apple developer tools"],
  [/^\/(usr\/)?bin\//u, "System"],
];

/** Who installed something, judged by where its file really lives; null when that says nothing. */
export function originFromPath(context: DiscoveryContext, executable: string): string | null {
  const real = (context.host.realPath(executable) ?? executable).replaceAll("\\", "/");
  return ORIGINS.find(([pattern]) => pattern.test(real))?.[1] ?? null;
}

/** Every PATH match, in PATH order. */
export function pathMatches(context: DiscoveryContext, names: ReadonlyArray<string>) {
  const path = pathModule(context.platform);
  return environmentPath(context).flatMap((directory) =>
    names.map((name) => path.join(directory, name)).filter(context.host.isExecutable),
  );
}

/** Newest-first entries of `directory` matching `pattern` or starting with it, bounded. */
export function versionedEntries(
  context: DiscoveryContext,
  directory: string,
  pattern: RegExp | string,
): ReadonlyArray<string> {
  return context.host
    .readDirectory(directory)
    .filter((entry) =>
      typeof pattern === "string" ? entry.startsWith(pattern) : pattern.test(entry),
    )
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
  const seen = new Map<string, number>();
  const result: DiscoveredRuntime[] = [];
  for (const runtime of runtimes) {
    const key = identity(
      context,
      runtime.executable,
      runtime.problem !== null || isEnvironment(runtime.executable),
    );
    const first = seen.get(key);
    if (first !== undefined) {
      // PATH finds a runtime first; a later source may know where it came from.
      if (result[first]!.origin === null)
        result[first] = { ...result[first]!, origin: runtime.origin };
      continue;
    }
    seen.set(key, result.length);
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
  const named = [
    venvRuntime(context, path.join(projectRoot, ".venv"), "project", ".venv"),
    condaRuntime(context, path.join(projectRoot, ".conda"), "project", ".conda"),
    ...pixiEnvironments.map((name) =>
      condaRuntime(context, path.join(pixi, name), "project", `pixi: ${name}`),
    ),
  ].filter((runtime): runtime is DiscoveredRuntime => runtime !== null);
  // `venv/` or `env/` is the project's when it is the only one. With several, none is assumed.
  const others = context.host
    .readDirectory(projectRoot)
    .filter((name) => name !== ".venv" && name !== ".conda")
    .filter((name) => context.host.kind(path.join(projectRoot, name, "pyvenv.cfg")) === "file")
    .toSorted()
    .slice(0, MAX_DIRECTORY_ENTRIES);
  const source = named.length === 0 && others.length === 1 ? "project" : "conventional";
  return [
    ...named,
    ...others
      .map((name) => venvRuntime(context, path.join(projectRoot, name), source, `${name}/`))
      .filter((runtime): runtime is DiscoveredRuntime => runtime !== null),
  ];
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

/**
 * macOS `/usr/bin/python3` is a launcher: it runs the developer tools' Python, which is listed
 * under its own name, or asks to install them.
 */
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
    // Anaconda's graphical installer for macOS.
    ...(context.platform === "darwin" ? names.map((name) => path.join(home, "opt", name)) : []),
    ...shared,
  ];
}

/** A conda prefix as people name it: its environment, `base` for a root, else its folder. */
function condaLabel(context: DiscoveryContext, prefix: string, roots: ReadonlySet<string>): string {
  const path = pathModule(context.platform);
  const name = path.basename(prefix);
  if (path.basename(path.dirname(prefix)) === "envs") return `conda: ${name}`;
  return `conda: ${roots.has(prefix) ? "base" : name}`;
}

/** Every conda-style prefix on this computer, whatever it holds. */
/** Where conda environments may be, read from the home folder without touching any of them. */
export function condaLocations(context: DiscoveryContext): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  const listed = (
    context.host.readText(path.join(context.homeDirectory, ".conda", "environments.txt")) ?? ""
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, MAX_DIRECTORY_ENTRIES);
  return [...new Set([...condaRoots(context), ...listed])];
}

/** Every conda-style environment at these locations, whether or not it holds Python. */
export function condaPrefixes(
  context: DiscoveryContext,
  locations: ReadonlyArray<string> = condaLocations(context),
): ReadonlyArray<{ readonly prefix: string; readonly origin: string }> {
  const path = pathModule(context.platform);
  const roots = condaRoots(context);
  const prefixes = locations.flatMap((location) => [
    location,
    ...context.host
      .readDirectory(path.join(location, "envs"))
      .toSorted()
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((name) => path.join(location, "envs", name)),
  ]);
  const known = new Set(roots);
  return [...new Set(prefixes)]
    .filter((prefix) => context.host.kind(path.join(prefix, "conda-meta")) === "directory")
    .map((prefix) => ({ prefix, origin: condaLabel(context, prefix, known) }));
}

function condaPythons(context: DiscoveryContext): ReadonlyArray<DiscoveredRuntime> {
  return condaPrefixes(context)
    .map(({ prefix, origin }) => condaRuntime(context, prefix, "conventional", origin))
    .filter((runtime): runtime is DiscoveredRuntime => runtime !== null);
}

/** Folders that hold one virtual environment per project, outside the projects themselves. */
function environmentStores(context: DiscoveryContext) {
  const path = pathModule(context.platform);
  const env = context.environment;
  const home = context.homeDirectory;
  const poetry =
    env.POETRY_VIRTUALENVS_PATH ??
    (context.platform === "win32"
      ? path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "pypoetry", "Cache")
      : context.platform === "darwin"
        ? path.join(home, "Library", "Caches", "pypoetry")
        : path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "pypoetry"));
  return [
    { root: env.WORKON_HOME ?? path.join(home, ".virtualenvs"), origin: "virtualenv" },
    { root: path.join(home, ".venvs"), origin: "virtualenv" },
    { root: path.join(home, "venvs"), origin: "virtualenv" },
    {
      root: env.POETRY_VIRTUALENVS_PATH ?? path.join(poetry, "virtualenvs"),
      origin: "Poetry",
    },
    {
      root: path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "virtualenvs"),
      origin: "Pipenv",
    },
  ];
}

function storePythons(context: DiscoveryContext): ReadonlyArray<DiscoveredRuntime> {
  const path = pathModule(context.platform);
  return environmentStores(context).flatMap(({ root, origin }) =>
    context.host
      .readDirectory(root)
      .toSorted()
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((name) =>
        venvRuntime(context, path.join(root, name), "conventional", `${origin}: ${name}`),
      )
      .filter((runtime): runtime is DiscoveredRuntime => runtime !== null),
  );
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
              env.UV_PYTHON_INSTALL_DIR ?? path.join(env.APPDATA!, "uv", "data", "python"),
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
  const entries = (items: ReadonlyArray<string>, origin: string | null) =>
    items.map((executable) => ({ executable, origin }));
  // A versioned formula has bin/python3.12 and keeps its plain python3 under libexec.
  const kegs = (roots: ReadonlyArray<string>) =>
    roots
      .flatMap((root) => versionedEntries(context, root, /^python@3/u))
      .flatMap((prefix) => [
        path.join(prefix, "bin", "python3"),
        path.join(prefix, "libexec", "bin", "python3"),
        path.join(prefix, "bin", path.basename(prefix).replace("@", "")),
      ]);
  const list: ReadonlyArray<{ readonly executable: string; readonly origin: string | null }> =
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
            ...entries(["/opt/homebrew/bin/python3"], "Homebrew"),
            // /usr/local/bin is shared: python.org's installer links there too.
            ...entries(["/usr/local/bin/python3"], null),
            ...entries(kegs(["/opt/homebrew/opt", "/usr/local/opt"]), "Homebrew"),
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
                ...kegs(["/home/linuxbrew/.linuxbrew/opt"]),
              ],
              "Homebrew",
            ),
            ...entries(["/usr/local/bin/python3", "/usr/bin/python3"], "System"),
          ];
  return list
    .filter((entry) => context.host.isExecutable(entry.executable))
    .map((entry) => ({
      executable: entry.executable,
      origin: originFromPath(context, entry.executable) ?? entry.origin,
      source: "conventional" as const,
      problem: null,
    }));
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
  const onPath = [
    ...pathMatches(
      context,
      context.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"],
    ),
    // Distributions install python3.11 beside an older python3.
    ...(context.platform === "win32"
      ? []
      : environmentPath(context).flatMap((directory) =>
          context.host
            .readDirectory(directory)
            .filter((name) => /^python3\.\d+$/u.test(name))
            .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }))
            .map((name) => path.join(directory, name))
            .filter(context.host.isExecutable),
        )),
  ]
    .filter((executable) => context.platform !== "darwin" || executable !== MACOS_PYTHON_SHIM)
    .map((executable) => ({
      executable,
      source: "path" as const,
      origin: originFromPath(context, executable),
      problem: context.platform === "win32" ? windowsAliasProblem(context, executable) : null,
    }));
  return dedupeRuntimes(
    context,
    [
      ...(input.projectRoot === null ? [] : projectPythons(context, input.projectRoot)),
      ...active,
      ...onPath,
      ...managerPythons(context),
      ...storePythons(context),
      ...condaPythons(context),
      ...systemPythons(context, input.windowsRegistrations),
    ],
    (executable) => isVirtualEnvironmentExecutable(context, executable),
  );
}
