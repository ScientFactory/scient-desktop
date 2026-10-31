import { pathModule, type DiscoveryContext } from "./RuntimeDiscovery.ts";

/**
 * Facts about installed runtimes, read from their files. Nothing here starts a program, so these
 * facts can be stale or incomplete: only a Test or a Run proves that something works.
 */

/** What the files say about a package. */
export type PackageFact =
  | { readonly state: "present"; readonly version: string | null }
  | { readonly state: "absent" }
  | { readonly state: "unknown" };

export interface PythonFacts {
  readonly version: string | null;
  readonly packages: (name: string) => PackageFact;
}

const MAX_PATH_FILES = 32;

const packageKey = (name: string) => name.toLowerCase().replaceAll("_", "-");

/** `name-1.2.dist-info`, `name-1.2-py3.12.egg-info` or `name.egg-info`. */
function metadataEntry(entry: string): readonly [string, string | null] | null {
  const match = /^(.+?)(?:-(\d[^-]*?))?(?:-py\d[\d.]*)?\.(?:dist|egg)-info$/iu.exec(entry);
  return match === null ? null : [packageKey(match[1]!), match[2] ?? null];
}

function readConfig(text: string | null): ReadonlyMap<string, string> {
  return new Map(
    (text ?? "").split(/\r?\n/u).flatMap((line) => {
      const match = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/u.exec(line);
      return match === null ? [] : [[match[1]!.toLowerCase(), match[2]!] as const];
    }),
  );
}

/** A runtime's prefix: the folder above its bin, or on Windows the folder it sits in. */
function pythonPrefix(context: DiscoveryContext, executable: string): string {
  const path = pathModule(context.platform);
  const directory = path.dirname(executable);
  if (context.platform !== "win32") return path.dirname(directory);
  return path.basename(directory).toLowerCase() === "scripts" ? path.dirname(directory) : directory;
}

function headerVersion(context: DiscoveryContext, prefix: string): string | null {
  const path = pathModule(context.platform);
  const headers =
    context.platform === "win32"
      ? [path.join(prefix, "include", "patchlevel.h")]
      : context.host
          .readDirectory(path.join(prefix, "include"))
          .filter((name) => /^python3\.\d+t?$/u.test(name))
          .map((name) => path.join(prefix, "include", name, "patchlevel.h"));
  for (const header of headers) {
    const match = /#define\s+PY_VERSION\s+"([^"]+)"/u.exec(context.host.readText(header) ?? "");
    if (match !== null) return match[1]!;
  }
  return null;
}

function condaVersion(context: DiscoveryContext, prefix: string): string | null {
  const path = pathModule(context.platform);
  for (const entry of context.host.readDirectory(path.join(prefix, "conda-meta"))) {
    const match = /^python-(\d+\.\d+[^-]*)-/u.exec(entry);
    if (match !== null) return match[1]!;
  }
  return null;
}

function siteDirectories(context: DiscoveryContext, prefix: string): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  if (context.platform === "win32") return [path.join(prefix, "Lib", "site-packages")];
  const versioned = ["lib", "lib64"].flatMap((lib) =>
    context.host
      .readDirectory(path.join(prefix, lib))
      .filter((name) => /^python3(\.\d+t?)?$/u.test(name))
      .flatMap((name) => [
        path.join(prefix, lib, name, "site-packages"),
        // Debian's system Python keeps packages here.
        path.join(prefix, lib, name, "dist-packages"),
      ]),
  );
  return versioned.filter((directory) => context.host.kind(directory) === "directory");
}

/** Plain paths in .pth files, as an editable install writes. Import lines need Python to run. */
function pathFileDirectories(context: DiscoveryContext, directory: string): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  return context.host
    .readDirectory(directory)
    .filter((name) => name.endsWith(".pth"))
    .slice(0, MAX_PATH_FILES)
    .flatMap((name) =>
      (context.host.readText(path.join(directory, name)) ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("import "))
        .map((line) => path.resolve(directory, line)),
    );
}

function packageVersions(
  context: DiscoveryContext,
  directories: ReadonlyArray<string>,
): ReadonlyMap<string, string | null> {
  const versions = new Map<string, string | null>();
  const all = [
    ...directories,
    ...directories.flatMap((directory) => pathFileDirectories(context, directory)),
  ];
  for (const directory of all) {
    for (const entry of context.host.readDirectory(directory)) {
      const parsed = metadataEntry(entry);
      if (parsed !== null && !versions.has(parsed[0])) versions.set(parsed[0], parsed[1]);
    }
  }
  return versions;
}

/** A Python's version and packages, from the files beside it. */
export function readPythonFacts(context: DiscoveryContext, executable: string): PythonFacts {
  const path = pathModule(context.platform);
  const environment = pythonPrefix(context, executable);
  const config = context.host.readText(path.join(environment, "pyvenv.cfg"));
  const settings = readConfig(config);
  const real = context.host.realPath(executable);
  const prefix = config === null && real !== null ? pythonPrefix(context, real) : environment;
  const home = settings.get("home");
  const inherited =
    settings.get("include-system-site-packages")?.toLowerCase() === "true" && home !== undefined
      ? siteDirectories(context, context.platform === "win32" ? home : path.dirname(home))
      : [];
  const directories = [...siteDirectories(context, prefix), ...inherited];
  const versions = packageVersions(context, directories);
  // Without a site folder there is nothing to say a package is missing from.
  const understood = directories.some((directory) => context.host.kind(directory) === "directory");
  return {
    version:
      settings.get("version") ??
      settings.get("version_info") ??
      condaVersion(context, prefix) ??
      headerVersion(context, prefix),
    packages: (name) => {
      const key = packageKey(name);
      if (versions.has(key)) return { state: "present", version: versions.get(key) ?? null };
      return understood ? { state: "absent" } : { state: "unknown" };
    },
  };
}

export interface RFacts {
  readonly home: string | null;
  readonly version: string | null;
  readonly architecture: string | null;
}

function rHome(context: DiscoveryContext, executable: string): string | null {
  const path = pathModule(context.platform);
  const real = context.host.realPath(executable) ?? executable;
  if (context.platform === "win32") {
    // bin\R.exe, or bin\x64\R.exe.
    const folder = path.dirname(real);
    const bin = path.basename(folder).toLowerCase() === "bin" ? folder : path.dirname(folder);
    return path.dirname(bin);
  }
  // bin/R is a shell script that names its home.
  const script = context.host.readText(real) ?? "";
  return /^R_HOME_DIR=["']?([^"'\n]+)/mu.exec(script)?.[1] ?? null;
}

/** An R's version from its own base package, without starting R. */
export function readRFacts(context: DiscoveryContext, executable: string): RFacts {
  const path = pathModule(context.platform);
  const home = rHome(context, executable);
  const description =
    home === null ? null : context.host.readText(path.join(home, "library", "base", "DESCRIPTION"));
  return {
    home,
    version: /^Version:\s*(\S+)/mu.exec(description ?? "")?.[1] ?? null,
    architecture: /^Built:\s*R [^;]+;[^;]*;[^;]*;\s*(\S+)/mu.exec(description ?? "")?.[1] ?? null,
  };
}

/** The libraries R searches that can be known without running it. */
function rLibraries(context: DiscoveryContext, facts: RFacts): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const series = facts.version?.split(".").slice(0, 2).join(".") ?? "";
  const home = context.homeDirectory;
  const splitter = context.platform === "win32" ? ";" : ":";
  const fromEnvironment = [env.R_LIBS, env.R_LIBS_USER, env.R_LIBS_SITE]
    .flatMap((value) => (value ?? "").split(splitter))
    .filter((entry) => entry.length > 0 && !entry.includes("%"));
  const own =
    facts.home === null
      ? []
      : [path.join(facts.home, "library"), path.join(facts.home, "site-library")];
  const shared =
    context.platform === "darwin"
      ? [
          `/opt/homebrew/lib/R/${series}/site-library`,
          `/usr/local/lib/R/${series}/site-library`,
          ...context.host
            .readDirectory(path.join(home, "Library", "R"))
            .map((arch) => path.join(home, "Library", "R", arch, series, "library")),
          path.join(home, "Library", "R", series, "library"),
        ]
      : context.platform === "win32"
        ? [
            path.join(
              env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
              "R",
              "win-library",
              series,
            ),
            path.join(home, "Documents", "R", "win-library", series),
          ]
        : [
            "/usr/local/lib/R/site-library",
            "/usr/lib/R/site-library",
            ...context.host
              .readDirectory(path.join(home, "R"))
              .map((platform) => path.join(home, "R", platform, series)),
          ];
  return [...fromEnvironment, ...own, ...shared];
}

/** Whether an R library this R searches holds a package, by its DESCRIPTION file. */
export function rPackageVersion(
  context: DiscoveryContext,
  facts: RFacts,
  name: string,
): string | null {
  const path = pathModule(context.platform);
  for (const library of rLibraries(context, facts)) {
    const description = context.host.readText(path.join(library, name, "DESCRIPTION"));
    const version = /^Version:\s*(\S+)/mu.exec(description ?? "")?.[1];
    if (version !== undefined) return version;
  }
  return null;
}

export interface JuliaFacts {
  readonly version: string | null;
}

function juliaupVersion(context: DiscoveryContext): string | null {
  const path = pathModule(context.platform);
  const depot =
    context.environment.JULIAUP_DEPOT_PATH ?? path.join(context.homeDirectory, ".julia");
  const text = context.host.readText(path.join(depot, "juliaup", "juliaup.json"));
  if (text === null) return null;
  const channel = /"Default"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  if (channel === undefined) return null;
  const installed = new RegExp(
    `"${channel.replace(/[.+*?^$()[\]{}|\\]/gu, "\\$&")}"\\s*:\\s*\\{[^}]*"Version"\\s*:\\s*"(\\d+\\.\\d+\\.\\d+)`,
    "u",
  );
  return installed.exec(text)?.[1] ?? null;
}

/** A Julia's version from its headers, or from juliaup's record for the launcher. */
export function readJuliaFacts(context: DiscoveryContext, executable: string): JuliaFacts {
  const path = pathModule(context.platform);
  const real = context.host.realPath(executable) ?? executable;
  const header = context.host.readText(
    path.join(path.dirname(path.dirname(real)), "include", "julia", "julia_version.h"),
  );
  return {
    version: /JULIA_VERSION_STRING\s+"([^"]+)"/u.exec(header ?? "")?.[1] ?? juliaupVersion(context),
  };
}

/** Whether the default environment of this Julia lists a package. */
export function juliaPackagePresent(
  context: DiscoveryContext,
  facts: JuliaFacts,
  name: string,
): boolean {
  const path = pathModule(context.platform);
  const series = facts.version?.split(".").slice(0, 2).join(".");
  if (series === undefined) return false;
  const splitter = context.platform === "win32" ? ";" : ":";
  const depots = (context.environment.JULIA_DEPOT_PATH ?? "")
    .split(splitter)
    .filter((entry) => entry.length > 0);
  return [...depots, path.join(context.homeDirectory, ".julia")].some((depot) => {
    const project = context.host.readText(
      path.join(depot, "environments", `v${series}`, "Project.toml"),
    );
    return new RegExp(`^${name}\\s*=`, "mu").test(project ?? "");
  });
}
