/** One way to run a file. `{file}` is the source and `{output}` a built program. */
export interface ComputeRunCommand {
  /** The tool's name, as the scan reports it. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Added after `args` everywhere except Windows, whose linkers refuse them. */
  readonly unixArgs?: ReadonlyArray<string>;
  /** After `args` builds `{output}`: what runs it. Absent runs `{output}` itself. */
  readonly build?: { readonly runner?: string; readonly args?: ReadonlyArray<string> };
}

export interface ComputeRunRoute {
  readonly languageId: string;
  readonly extensions: ReadonlyArray<string>;
  /** Best first. The first one found on the computer runs the file. */
  readonly commands: ReadonlyArray<ComputeRunCommand>;
  /** Name shown for a route no catalog language covers. */
  readonly label?: string;
}

const file = (command: string, ...flags: ReadonlyArray<string>): ComputeRunCommand => ({
  command,
  args: [...flags, "{file}"],
});

const compiled = (command: string, ...flags: ReadonlyArray<string>): ComputeRunCommand => ({
  command,
  args: [...flags, "{file}", "-o", "{output}"],
  build: {},
});

/** gcc on Linux needs the math library named, and `sqrt` is in most scientific programs. */
const withMath = (command: ComputeRunCommand): ComputeRunCommand => ({
  ...command,
  unixArgs: ["-lm"],
});

/** C++ compilers still default to old standards, so modern code would not build. */
const CPP_STANDARD = "-std=gnu++2b";

/** Compiler flags for `cl`, which takes neither `-o` nor a separate output argument. */
const msvc: ComputeRunCommand = {
  command: "cl",
  args: ["/nologo", "/Fe:{output}", "{file}"],
  build: {},
};
const msvcCpp: ComputeRunCommand = {
  command: "cl",
  args: ["/nologo", "/EHsc", "/std:c++latest", "/Fe:{output}", "{file}"],
  build: {},
};

/**
 * Every language that runs from its file. Python, R, Julia, SQL and MATLAB have sessions of their
 * own. A file type two languages share goes to the first one installed, in the order listed here.
 */
export const COMPUTE_RUN_TABLE: ReadonlyArray<ComputeRunRoute> = [
  { languageId: "bash", extensions: [".sh", ".bash"], commands: [file("bash")] },
  {
    languageId: "powershell",
    extensions: [".ps1"],
    commands: [file("pwsh", "-File"), file("powershell", "-File")],
  },
  {
    languageId: "javascript",
    extensions: [".js", ".mjs", ".cjs"],
    commands: [file("node"), file("deno", "run"), file("bun", "run")],
  },
  {
    languageId: "typescript",
    extensions: [".ts"],
    commands: [file("deno", "run"), file("bun", "run")],
  },
  {
    languageId: "c",
    extensions: [".c"],
    commands: [...["clang", "gcc", "cc"].map((name) => withMath(compiled(name))), msvc],
  },
  {
    languageId: "cpp",
    extensions: [".cpp", ".cc", ".cxx"],
    commands: [
      ...["clang++", "g++", "c++"].map((name) => withMath(compiled(name, CPP_STANDARD))),
      msvcCpp,
    ],
  },
  {
    languageId: "fortran",
    extensions: [".f90", ".f95", ".f03", ".f08", ".f"],
    commands: ["gfortran", "ifx", "ifort", "flang", "nvfortran", "lfortran"].map((name) =>
      compiled(name),
    ),
  },
  // Without an edition rustc reads a file as 2015. 2021 also works on older compilers, unlike 2024.
  { languageId: "rust", extensions: [".rs"], commands: [compiled("rustc", "--edition", "2021")] },
  { languageId: "go", extensions: [".go"], commands: [file("go", "run")] },
  { languageId: "java", extensions: [".java"], commands: [file("java")] },
  {
    languageId: "kotlin",
    extensions: [".kts"],
    commands: [file("kotlinc", "-script"), file("kotlin")],
  },
  {
    languageId: "scala",
    extensions: [".scala", ".sc"],
    commands: [file("scala-cli", "run"), file("scala", "run")],
  },
  { languageId: "perl", extensions: [".pl", ".pm"], commands: [file("perl")] },
  {
    languageId: "stata",
    extensions: [".do"],
    commands: ["stata-mp", "stata-se", "stata-be", "stata"].map((name) => file(name, "-b", "do")),
  },
  { languageId: "sas", extensions: [".sas"], commands: [file("sas", "-sysin")] },
  {
    languageId: "spss",
    extensions: [".sps"],
    commands: [file("pspp"), { command: "stats", args: ["{file}", "-production"] }],
  },
  {
    languageId: "wolfram-language",
    extensions: [".wl", ".wls"],
    commands: [file("wolframscript", "-file")],
  },
  { languageId: "stan", extensions: [".stan"], commands: [file("stanc")] },
  { languageId: "lean", extensions: [".lean"], commands: [file("lean")] },
  {
    languageId: "isabelle",
    extensions: [".thy"],
    commands: [{ command: "isabelle", args: ["process", "-T", "{file}"] }],
  },
  { languageId: "sage", extensions: [".sage"], commands: [file("sage")] },
  { languageId: "gap", extensions: [".g", ".gap"], commands: [file("gap", "-q")] },
  { languageId: "macaulay2", extensions: [".m2"], commands: [file("M2", "--script")] },
  { languageId: "singular", extensions: [".sing"], commands: [file("Singular", "-q")] },
  { languageId: "maxima", extensions: [".mac"], commands: [file("maxima", "-b")] },
  { languageId: "maple", extensions: [".mpl"], commands: [file("maple", "-q")] },
  { languageId: "nextflow", extensions: [".nf"], commands: [file("nextflow", "run")] },
  {
    languageId: "snakemake",
    extensions: [".smk"],
    commands: [{ command: "snakemake", args: ["--cores", "1", "-s", "{file}"] }],
  },
  { languageId: "gnuplot", extensions: [".plt", ".gnu", ".gp"], commands: [file("gnuplot")] },
  {
    languageId: "imagej-macro",
    extensions: [".ijm"],
    commands: [
      { command: "fiji", args: ["--headless", "-macro", "{file}"] },
      { command: "ImageJ", args: ["--headless", "-macro", "{file}"] },
    ],
  },
  { languageId: "root", extensions: [".C"], commands: [file("root", "-b", "-q")] },
  {
    languageId: "idl",
    extensions: [".pro"],
    commands: [file("idl", "-quiet"), file("gdl", "-quiet")],
  },
  { languageId: "mplus", extensions: [".inp"], commands: [file("mplus")] },
  {
    languageId: "octave",
    extensions: [".m"],
    commands: [file("octave-cli"), file("octave", "--no-gui")],
  },
  { languageId: "magma", extensions: [".m"], commands: [file("magma")] },
  { languageId: "coq", extensions: [".v"], commands: [file("coqc"), file("rocq", "compile")] },
  { languageId: "gp", extensions: [".gp"], commands: [file("gp", "-q")] },
  { languageId: "haskell", extensions: [".hs"], commands: [file("runghc")] },
  { languageId: "ocaml", extensions: [".ml"], commands: [file("ocaml")] },
  { languageId: "clojure", extensions: [".clj"], commands: [file("clojure", "-M"), file("bb")] },
  {
    languageId: "common-lisp",
    extensions: [".lisp", ".cl"],
    commands: [file("sbcl", "--script"), file("clisp"), file("ecl", "--shell")],
  },
  { languageId: "racket", extensions: [".rkt"], commands: [file("racket")] },
  { languageId: "ruby", extensions: [".rb"], commands: [file("ruby")] },
  {
    languageId: "lua",
    extensions: [".lua"],
    commands: ["lua", "luajit", "lua5.4", "lua5.3"].map((name) => file(name)),
  },
  {
    languageId: "tcl",
    extensions: [".tcl"],
    commands: ["tclsh", "tclsh9.0", "tclsh8.6"].map((name) => file(name)),
  },
  { languageId: "elixir", extensions: [".exs"], commands: [file("elixir")] },
  { languageId: "erlang", extensions: [".erl"], commands: [file("escript")] },
  { languageId: "csharp", extensions: [".cs"], commands: [file("dotnet", "run")] },
  { languageId: "fsharp", extensions: [".fsx"], commands: [file("dotnet", "fsi")] },
  { languageId: "zig", extensions: [".zig"], commands: [file("zig", "run")] },
  { languageId: "nim", extensions: [".nim"], commands: [file("nim", "r")] },
  { languageId: "prolog", extensions: [".plg", ".pro"], commands: [file("swipl")] },
  {
    languageId: "apl",
    extensions: [".apl"],
    commands: [file("dyalogscript"), file("apl", "--script")],
  },
  {
    languageId: "verilog",
    extensions: [".sv", ".vh", ".v"],
    commands: [
      {
        command: "iverilog",
        args: ["-o", "{output}", "{file}"],
        build: { runner: "vvp", args: ["{output}"] },
      },
    ],
  },
  { languageId: "vhdl", extensions: [".vhd", ".vhdl"], commands: [file("ghdl", "-a")] },
  { languageId: "modelica", extensions: [".mo"], commands: [file("omc")] },
  {
    languageId: "scilab",
    extensions: [".sce"],
    commands: ["scilab-cli", "scilab"].map((name) => file(name, "-nb", "-f")),
  },
  { languageId: "minizinc", extensions: [".mzn"], commands: [file("minizinc")] },
  { languageId: "ampl", extensions: [".mod"], commands: [file("ampl")] },
  { languageId: "gams", extensions: [".gms"], commands: [file("gams")] },
  { languageId: "jags", extensions: [".jags"], commands: [file("jags")] },
  {
    languageId: "netlogo",
    extensions: [".nlogo"],
    commands: [{ command: "netlogo-headless", args: ["--model", "{file}"] }],
  },
  { languageId: "agda", extensions: [".agda"], commands: [file("agda")] },
  // SQL runs on DuckDB in a session. This is for a script written for sqlite3's own commands.
  {
    languageId: "sqlite",
    label: "SQLite",
    extensions: [".sql"],
    commands: [{ command: "sqlite3", args: ["-bail", ":memory:", ".read '{file}'"] }],
  },
];

/** A script that uses sqlite3's own dot commands, which no other SQL engine reads. */
export function isSqliteScript(contents: string): boolean {
  return /^\s*\.[a-z]+\b/mu.test(contents);
}

/**
 * Every route for a file, best first. An extension with capitals, like ROOT's `.C`, matches only
 * exactly, and comes before the same letters in lower case.
 */
export function computeRunRoutesForPath(path: string): ReadonlyArray<ComputeRunRoute> {
  const lower = path.toLowerCase();
  const exact = COMPUTE_RUN_TABLE.filter((route) =>
    route.extensions.some(
      (extension) => extension !== extension.toLowerCase() && path.endsWith(extension),
    ),
  );
  const rest = COMPUTE_RUN_TABLE.filter(
    (route) =>
      !exact.includes(route) &&
      route.extensions.some(
        (extension) => extension === extension.toLowerCase() && lower.endsWith(extension),
      ),
  );
  return [...exact, ...rest];
}

export function computeRunRouteForPath(path: string): ComputeRunRoute | undefined {
  return computeRunRoutesForPath(path)[0];
}

/** Newest first. A version the scan could not read goes last, keeping the order it was found. */
function newestFirst(left: string | null | undefined, right: string | null | undefined): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  const parts = (version: string) => (version.match(/\d+/gu) ?? []).map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const SYSTEM_TOOL = /^\/(?:System\/Cryptexes\/App\/)?(?:usr\/)?s?bin\/|^[a-z]:\\windows\\/iu;

/** The copy a computer came with, which nobody chose. */
export function isSystemTool(executable: string): boolean {
  return SYSTEM_TOOL.test(executable);
}

/**
 * What Run can start for a language, best first: the commands in the table's order and, for each,
 * the copy PATH finds first, because that is what the person's terminal runs. Only the system's
 * own copy gives way to a newer install. The first one runs a file unless someone chooses another.
 * An app bundle proves the language is here, but it is not a program Run can start.
 */
export function computeRunnableTools<
  Tool extends {
    readonly name: string;
    readonly executable: string;
    readonly version?: string | null;
  },
>(route: ComputeRunRoute, tools: ReadonlyArray<Tool>): ReadonlyArray<Tool> {
  return route.commands.flatMap((command) => {
    const [first, ...rest] = tools.filter(
      (tool) => tool.name === command.command && !/\.app$/iu.test(tool.executable),
    );
    if (first === undefined) return [];
    const newest = (found: ReadonlyArray<Tool>) =>
      [...found].sort((left, right) => newestFirst(left.version, right.version));
    return isSystemTool(first.executable) ? newest([first, ...rest]) : [first, ...newest(rest)];
  });
}
