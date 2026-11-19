import type { CommandCategory } from "@scientfactory/analytics";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/**
 * What kind of program an agent ran in its own terminal, read on this computer. Only the closed
 * category leaves it: never the command, its arguments, paths or output.
 */
const PROGRAMS: Readonly<Record<string, CommandCategory>> = {
  python: "python",
  py: "python",
  ipython: "python",
  pytest: "python",
  uvx: "python",
  pip: "python-package-install",
  conda: "python-package-install",
  mamba: "python-package-install",
  micromamba: "python-package-install",
  jupyter: "jupyter",
  "jupyter-nbconvert": "jupyter",
  papermill: "jupyter",
  r: "r",
  rscript: "r",
  julia: "julia",
  matlab: "matlab",
  octave: "octave",
  "octave-cli": "octave",
  stata: "stata",
  "stata-mp": "stata",
  "stata-se": "stata",
  statamp: "stata",
  statase: "stata",
  sas: "sas",
  sqlite3: "sql",
  duckdb: "sql",
  psql: "sql",
  mysql: "sql",
  pdflatex: "latex",
  xelatex: "latex",
  lualatex: "latex",
  latex: "latex",
  latexmk: "latex",
  tectonic: "latex",
  bibtex: "latex",
  biber: "latex",
  pandoc: "document-convert",
  soffice: "document-convert",
  libreoffice: "document-convert",
  wkhtmltopdf: "document-convert",
  quarto: "quarto",
  snakemake: "workflow",
  nextflow: "workflow",
  cwltool: "workflow",
  sbatch: "hpc",
  srun: "hpc",
  squeue: "hpc",
  scancel: "hpc",
  sacct: "hpc",
  qsub: "hpc",
  qstat: "hpc",
  bsub: "hpc",
  ssh: "remote",
  scp: "remote",
  rsync: "remote",
  sftp: "remote",
  docker: "container",
  podman: "container",
  singularity: "container",
  apptainer: "container",
  gcc: "compile",
  "g++": "compile",
  cc: "compile",
  clang: "compile",
  "clang++": "compile",
  make: "compile",
  cmake: "compile",
  cargo: "compile",
  rustc: "compile",
  go: "compile",
  javac: "compile",
  java: "compile",
  mvn: "compile",
  gradle: "compile",
  dotnet: "compile",
  swift: "compile",
  swiftc: "compile",
  node: "javascript",
  npm: "javascript",
  pnpm: "javascript",
  yarn: "javascript",
  bun: "javascript",
  deno: "javascript",
  npx: "javascript",
  tsx: "javascript",
  brew: "system-package-install",
  apt: "system-package-install",
  "apt-get": "system-package-install",
  dnf: "system-package-install",
  yum: "system-package-install",
  port: "system-package-install",
  choco: "system-package-install",
  winget: "system-package-install",
  git: "version-control",
  gh: "version-control",
  curl: "download",
  wget: "download",
  ls: "file-inspection",
  cat: "file-inspection",
  head: "file-inspection",
  tail: "file-inspection",
  grep: "file-inspection",
  rg: "file-inspection",
  find: "file-inspection",
  fd: "file-inspection",
  sed: "file-inspection",
  awk: "file-inspection",
  wc: "file-inspection",
  sort: "file-inspection",
  uniq: "file-inspection",
  tree: "file-inspection",
  file: "file-inspection",
  stat: "file-inspection",
  du: "file-inspection",
  diff: "file-inspection",
  jq: "file-inspection",
  cut: "file-inspection",
  nl: "file-inspection",
  less: "file-inspection",
  mkdir: "file-management",
  cp: "file-management",
  mv: "file-management",
  rm: "file-management",
  touch: "file-management",
  chmod: "file-management",
  ln: "file-management",
  tar: "file-management",
  zip: "file-management",
  unzip: "file-management",
};

/** Builtins and glue that say nothing about the work. */
const IGNORED = new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "export",
  "set",
  "unset",
  "source",
  ".",
  "true",
  "false",
  "sleep",
  "exit",
  "test",
  "[",
  "[[",
  "pwd",
  "wait",
]);

/** Prefixes that run the program named after them. */
const WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "env", "exec", "command", "xargs"]);
/** `<runner> run <program>` style launchers. */
const RUNNERS = new Set(["uv", "poetry", "pipenv", "pixi", "hatch", "rye", "pdm"]);
const PACKAGE_VERBS = new Set(["install", "add", "update", "upgrade", "uninstall", "remove"]);

const QUOTED_ESCAPES = new Set(['"', "\\", "$", "`"]);
const ESCAPES = new Set([" ", "\t", "'", '"', "\\", ";", "&", "|", "(", ")", "\n"]);

/** Splits on unquoted `&&`, `||`, `;`, `|` and newlines, then into words. */
function segments(command: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) result.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && QUOTED_ESCAPES.has(command[index + 1] ?? ""))
        word += command[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    // A Windows path keeps its backslashes; only shell-special characters are escaped.
    else if (char === "\\" && ESCAPES.has(command[index + 1] ?? "")) word += command[++index];
    // `2>&1` and `&>` are redirections, not command separators.
    else if (char === "&" && (command[index - 1] === ">" || command[index + 1] === ">"))
      word += char;
    else if (char === ";" || char === "\n" || char === "|" || char === "&") {
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      endSegment();
    } else if (char === " " || char === "\t" || char === "(" || char === ")") endWord();
    else word += char;
  }
  endSegment();
  return result;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "powershell", "pwsh", "cmd"]);

function programName(word: string): string {
  const base = word.split(/[\\/]/u).at(-1) ?? word;
  return base
    .toLowerCase()
    .replace(/\.exe$/u, "")
    .replace(/^(python|pip)[0-9.]*$/u, "$1");
}

function classifySegment(words: ReadonlyArray<string>, depth: number): CommandCategory[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const name = programName(word);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) || WRAPPERS.has(name)) index += 1;
    else if (name === "timeout") index += 2;
    else break;
  }
  const program = words[index];
  if (program === undefined) return [];
  const name = programName(program);
  const rest = words.slice(index + 1);
  if (SHELLS.has(name)) {
    const script = rest.find(
      (_, at) => at > 0 && /^-[A-Za-z]*c$|^-command$|^\/c$/iu.test(rest[at - 1]!),
    );
    return script === undefined || depth > 2 ? ["shell-other"] : classifyCommand(script, depth + 1);
  }
  if (IGNORED.has(name)) return [];
  if (RUNNERS.has(name)) {
    if (rest[0] === "run" && rest.length > 1) return classifySegment(rest.slice(1), depth);
    if (rest[0] === "pip" || PACKAGE_VERBS.has(rest[0] ?? "")) return ["python-package-install"];
    return ["python"];
  }
  if ((name === "conda" || name === "mamba" || name === "micromamba") && rest[0] === "run") {
    const at = rest.findIndex(
      (arg, position) =>
        position > 0 &&
        !arg.startsWith("-") &&
        !["-n", "--name", "-p", "--prefix"].includes(rest[position - 1]!),
    );
    return at === -1 ? ["python"] : classifySegment(rest.slice(at), depth);
  }
  if (name === "python" || name === "py") {
    const module = rest[0] === "-m" ? rest[1] : undefined;
    if (module === "pip") return ["python-package-install"];
    if (module === "jupyter" || module === "nbconvert" || module === "papermill")
      return ["jupyter"];
    return ["python"];
  }
  if (name === "npx" || name === "pnpm" || name === "yarn" || name === "bun") {
    if (name === "npx" || rest[0] === "exec" || rest[0] === "dlx") {
      const tool = rest.find((arg, at) => at > (name === "npx" ? -1 : 0) && !arg.startsWith("-"));
      const category = tool === undefined ? undefined : PROGRAMS[programName(tool)];
      if (category !== undefined && category !== "javascript") return [category];
    }
  }
  return [PROGRAMS[name] ?? "shell-other"];
}

/** The distinct kinds of program one terminal command ran; empty when it ran nothing notable. */
export function classifyCommand(command: string, depth = 0): CommandCategory[] {
  const categories = new Set<CommandCategory>();
  for (const words of segments(command.slice(0, 4_096)))
    for (const category of classifySegment(words, depth)) categories.add(category);
  return [...categories];
}

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "execute",
  "exec",
  "exec_command",
  "run_command",
  "run_terminal_cmd",
  "terminal",
  "local_shell",
  "powershell",
]);

/** The command an agent's own shell tool ran, from a typed or a provider-native tool item. */
export function shellCommandOf(item: OrchestrationV2TurnItem): string | undefined {
  if (item.type === "command_execution") return item.input;
  if (item.type !== "dynamic_tool" || item.toolName === null) return undefined;
  if (!SHELL_TOOLS.has(item.toolName.toLowerCase())) return undefined;
  const input = item.input;
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of ["command", "cmd", "script"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string"))
      return value.join(" ");
  }
  return undefined;
}
