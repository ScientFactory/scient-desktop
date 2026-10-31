import {
  condaPrefixes,
  originFromPath,
  pathModule,
  type DiscoveryContext,
} from "./RuntimeDiscovery.ts";
import { LANGUAGE_TOOLS, type LanguageTools } from "./ToolCatalog.ts";

/** Finding reads names and links. It never starts a tool, and a tool's version may stay unknown. */
export interface FoundLanguageTool {
  readonly languageId: string;
  readonly name: string;
  readonly executable: string;
  readonly identity: string;
  readonly version: string | null;
  readonly origin: string | null;
}

/** One place to read. A stalled drive holds up only the step that reaches it. */
export interface ToolScanStep {
  readonly source: string;
  readonly run: () => ReadonlyArray<FoundLanguageTool>;
}

const MAX_MATCHES = 256;
/** System folders can be large; each entry costs one lookup, and a program must not be cut off. */
const FOLDER_LIMIT = 100_000;
const WINDOWS_EXTENSIONS = /\.(exe|cmd|bat|com)$/iu;

/** Runnable on macOS only once developer tools exist; until then they offer to install them. */
const XCODE_STUBS: ReadonlySet<string> = new Set([
  "clang",
  "clang++",
  "cc",
  "c++",
  "gcc",
  "g++",
  "git",
  "make",
  "swift",
]);
const JAVA_STUBS: ReadonlySet<string> = new Set(["java", "javac", "jar"]);

/** Launchers that pick a version at run time. The versions themselves are searched instead. */
const SHIM_FOLDERS =
  /[\\/](\.pyenv|\.rbenv|\.nodenv|\.jenv|\.asdf|mise)[\\/]shims$|[\\/]scoop[\\/]shims$/u;

const VERSION_IN_PATH: ReadonlyArray<RegExp> = [
  /\/Cellar\/[^/]+\/(\d[^/_]*)/u,
  /\/versions\/(?:node\/)?v?(\d[^/]*)\/bin\//u,
  /\/installs\/[^/]+\/v?(\d[^/]*)\/bin\//u,
  /\/ghc\/(\d[^/]*)\/bin\//u,
  /\/candidates\/[^/]+\/(\d[^/-]*)/u,
  /\/cmdstan-(\d[^/]*)\//u,
  /\/(?:R|Octave|JAGS|Maxima|scilab|Julia)-(\d[\d.]*)[/.]/u,
];

function versionFromPath(real: string): string | null {
  const path = real.replaceAll("\\", "/");
  for (const pattern of VERSION_IN_PATH) {
    const version = pattern.exec(path)?.[1];
    if (version !== undefined) return version;
  }
  return null;
}

function developerToolsPresent(context: DiscoveryContext): boolean {
  return (
    context.host.kind("/Library/Developer/CommandLineTools/usr/bin") === "directory" ||
    context.host.realPath("/var/db/xcode_select_link") !== null
  );
}

function javaPresent(context: DiscoveryContext): boolean {
  return (
    context.environment.JAVA_HOME !== undefined ||
    context.host.readDirectory("/Library/Java/JavaVirtualMachines").length > 0
  );
}

/** A stand-in the system ships, which is not the tool and may open an installer when started. */
function isStub(context: DiscoveryContext, directory: string, name: string): boolean {
  if (context.platform === "darwin" && directory === "/usr/bin") {
    if (XCODE_STUBS.has(name)) return !developerToolsPresent(context);
    if (JAVA_STUBS.has(name)) return !javaPresent(context);
    return false;
  }
  if (context.platform !== "win32") return false;
  // The WSL launcher, which needs no Linux to be installed.
  return /\\system32$/iu.test(directory) && /^(bash|wsl)$/iu.test(name);
}

function expandVariables(context: DiscoveryContext, pattern: string): string | null {
  const path = pathModule(context.platform);
  const expanded = pattern.startsWith("~")
    ? path.join(context.homeDirectory, pattern.slice(1))
    : pattern;
  let unknown = false;
  const result = expanded.replace(/%([^%]+)%/gu, (_match, name: string) => {
    const value = context.environment[name];
    if (value === undefined) unknown = true;
    return value ?? "";
  });
  return unknown ? null : result;
}

/** Folders and files matching a pattern, where `*` stands for part of one path level. */
export function expandPlace(context: DiscoveryContext, pattern: string): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  const expanded = expandVariables(context, pattern);
  if (expanded === null) return [];
  const separator = context.platform === "win32" ? "\\" : "/";
  const parts = expanded.split(/[\\/]/u);
  const first = context.platform === "win32" ? `${parts[0]}${separator}` : separator;
  let current: ReadonlyArray<string> = [first];
  for (const part of parts.slice(1)) {
    if (part === "") continue;
    if (!part.includes("*")) {
      current = current.map((directory) => path.join(directory, part));
      continue;
    }
    const matcher = new RegExp(
      `^${part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`,
      "iu",
    );
    current = current
      .flatMap((directory) =>
        context.host
          .readDirectory(directory)
          .filter((entry) => matcher.test(entry))
          .map((entry) => path.join(directory, entry)),
      )
      .slice(0, MAX_MATCHES);
  }
  return current.filter((candidate) => context.host.kind(candidate) !== null);
}

interface WantedTool {
  readonly languageId: string;
  readonly command: string;
  readonly tools: LanguageTools;
}

function wantedCommands(context: DiscoveryContext): ReadonlyMap<string, ReadonlyArray<WantedTool>> {
  const wanted = new Map<string, WantedTool[]>();
  for (const [languageId, tools] of Object.entries(LANGUAGE_TOOLS)) {
    for (const command of tools.commands) {
      const key = context.platform === "win32" ? command.toLowerCase() : command;
      wanted.set(key, [...(wanted.get(key) ?? []), { languageId, command, tools }]);
    }
  }
  return wanted;
}

function found(
  context: DiscoveryContext,
  languageId: string,
  name: string,
  executable: string,
  origin: string | null,
): FoundLanguageTool {
  const real = context.host.realPath(executable) ?? executable;
  return {
    languageId,
    name,
    executable,
    identity: context.platform === "win32" ? real.toLowerCase() : real,
    version: versionFromPath(real),
    origin: origin ?? originFromPath(context, executable),
  };
}

function scanFolder(
  context: DiscoveryContext,
  directory: string,
  wanted: ReadonlyMap<string, ReadonlyArray<WantedTool>>,
  origin: string | null,
): ReadonlyArray<FoundLanguageTool> {
  const path = pathModule(context.platform);
  return context.host.readDirectory(directory, FOLDER_LIMIT).flatMap((entry) => {
    const bare =
      context.platform === "win32" ? entry.toLowerCase().replace(WINDOWS_EXTENSIONS, "") : entry;
    const tools = wanted.get(bare);
    if (tools === undefined) return [];
    const executable = path.join(directory, entry);
    if (!context.host.isExecutable(executable) || isStub(context, directory, bare)) return [];
    const developerTool =
      context.platform === "darwin" && directory === "/usr/bin" && XCODE_STUBS.has(bare);
    return tools
      .filter(
        ({ tools: rule }) =>
          rule.beside === undefined ||
          context.host.kind(path.join(directory, rule.beside)) === "directory",
      )
      .map(({ languageId, command }) =>
        found(context, languageId, command, executable, developerTool ? "Xcode tools" : origin),
      );
  });
}

function environmentPathEntries(context: DiscoveryContext): ReadonlyArray<string> {
  const value =
    context.platform === "win32"
      ? (context.environment.Path ?? context.environment.PATH)
      : context.environment.PATH;
  return (value ?? "")
    .split(context.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((entry) => entry.length > 0);
}

/** Folders that hold tools outside PATH, for a person whose shell setup Scient cannot see. */
function managerFolders(context: DiscoveryContext): ReadonlyArray<string> {
  const env = context.environment;
  const tree = (name: string, fallback: string) => env[name] ?? fallback;
  const toolchains = [
    `${tree("PYENV_ROOT", "~/.pyenv")}/versions/*/bin`,
    `${tree("ASDF_DATA_DIR", "~/.asdf")}/installs/*/*/bin`,
    `${tree("RUSTUP_HOME", "~/.rustup")}/toolchains/*/bin`,
    `${tree("CARGO_HOME", "~/.cargo")}/bin`,
    `${tree("ELAN_HOME", "~/.elan")}/toolchains/*/bin`,
    `${tree("OPAMROOT", "~/.opam")}/*/bin`,
    `${tree("SDKMAN_DIR", "~/.sdkman")}/candidates/*/*/bin`,
    `${tree("NVM_DIR", "~/.nvm")}/versions/node/*/bin`,
    "~/.rbenv/versions/*/bin",
    "~/.nodenv/versions/*/bin",
    "~/.ghcup/bin",
    "~/.ghcup/ghc/*/bin",
    "~/.deno/bin",
    "~/.bun/bin",
    "~/.dotnet",
    "~/.cabal/bin",
    "~/.nimble/bin",
    "~/.pixi/bin",
    "~/.pixi/envs/*/bin",
    "~/.local/bin",
    "~/go/bin",
    "~/bin",
  ];
  if (context.platform === "darwin")
    return [
      ...toolchains,
      `${tree("MISE_DATA_DIR", "~/.local/share/mise")}/installs/*/*/bin`,
      "/opt/homebrew/bin",
      "/opt/homebrew/opt/*/bin",
      "/usr/local/bin",
      "/usr/local/opt/*/bin",
      "/opt/local/bin",
      "/usr/bin",
      "/bin",
    ];
  if (context.platform === "win32")
    return [
      ...toolchains.map((folder) => folder.replaceAll("/", "\\")),
      "%ProgramFiles%\\*\\bin",
      "%ProgramFiles%\\Git\\usr\\bin",
      "%LOCALAPPDATA%\\Programs\\*\\bin",
      "%ProgramData%\\chocolatey\\bin",
      "~\\scoop\\apps\\*\\current\\bin",
      "~\\scoop\\apps\\*\\current",
      "C:\\msys64\\usr\\bin",
      "C:\\msys64\\mingw64\\bin",
      "C:\\msys64\\ucrt64\\bin",
    ];
  return [
    ...toolchains,
    `${tree("MISE_DATA_DIR", "~/.local/share/mise")}/installs/*/*/bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/*/bin",
    "/snap/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/opt/*/bin",
  ];
}

function condaFolders(context: DiscoveryContext, prefix: string): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  return context.platform === "win32"
    ? [prefix, path.join(prefix, "Scripts"), path.join(prefix, "Library", "bin")]
    : [path.join(prefix, "bin")];
}

/** Every place to read, in the order that decides which copy of a tool leads. */
export function toolScanSteps(context: DiscoveryContext): ReadonlyArray<ToolScanStep> {
  const wanted = wantedCommands(context);
  const pathFolders = environmentPathEntries(context).filter((entry) => !SHIM_FOLDERS.test(entry));
  const folderStep = (directory: string, origin: string | null = null): ToolScanStep => ({
    source: directory,
    run: () => scanFolder(context, directory, wanted, origin),
  });
  const placeSteps = Object.entries(LANGUAGE_TOOLS).flatMap(([languageId, tools]) =>
    (tools.places?.[context.platform as "darwin" | "linux" | "win32"] ?? []).map((place) => ({
      source: place,
      run: () => {
        const path = pathModule(context.platform);
        return expandPlace(context, place).map((executable) =>
          found(
            context,
            languageId,
            path.basename(executable).replace(/\.app$/u, ""),
            executable,
            null,
          ),
        );
      },
    })),
  );
  return [
    ...pathFolders.map((directory) => folderStep(directory)),
    ...managerFolders(context).map((pattern) => ({
      source: pattern,
      run: () =>
        expandPlace(context, pattern).flatMap((directory) =>
          scanFolder(context, directory, wanted, null),
        ),
    })),
    {
      source: "conda",
      run: () =>
        condaPrefixes(context).flatMap(({ prefix, origin }) =>
          condaFolders(context, prefix).flatMap((directory) =>
            scanFolder(context, directory, wanted, origin),
          ),
        ),
    },
    ...placeSteps,
  ];
}

/** The tools of each language: the first place found leads, then the catalog's order. */
export function groupTools(
  tools: ReadonlyArray<FoundLanguageTool>,
): ReadonlyMap<string, ReadonlyArray<FoundLanguageTool>> {
  const grouped = new Map<string, FoundLanguageTool[]>();
  const seen = new Set<string>();
  for (const tool of tools) {
    const key = `${tool.languageId}\n${tool.identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grouped.set(tool.languageId, [...(grouped.get(tool.languageId) ?? []), tool]);
  }
  const rank = (tool: FoundLanguageTool) => {
    const index = LANGUAGE_TOOLS[tool.languageId]?.commands.indexOf(tool.name) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const folder = (tool: FoundLanguageTool) => tool.executable.replace(/[\\/][^\\/]*$/u, "");
  for (const [languageId, found] of grouped) {
    const places = [...new Set(found.map(folder))];
    grouped.set(
      languageId,
      found.toSorted(
        (a, b) => places.indexOf(folder(a)) - places.indexOf(folder(b)) || rank(a) - rank(b),
      ),
    );
  }
  return grouped;
}
