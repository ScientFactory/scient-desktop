/** One way to run a file. `{file}` is the source and `{output}` a built program. */
export interface ComputeRunCommand {
  /** The tool's name, as the scan reports it. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** After `args` builds `{output}`: what runs it. Absent runs `{output}` itself. */
  readonly build?: { readonly runner?: string; readonly args?: ReadonlyArray<string> };
}

export interface ComputeRunRoute {
  readonly languageId: string;
  readonly extensions: ReadonlyArray<string>;
  /** Best first. The first one found on the computer runs the file. */
  readonly commands: ReadonlyArray<ComputeRunCommand>;
}

const file = (command: string, ...flags: ReadonlyArray<string>): ComputeRunCommand => ({
  command,
  args: [...flags, "{file}"],
});

const compiled = (command: string): ComputeRunCommand => ({
  command,
  args: ["{file}", "-o", "{output}"],
  build: {},
});

/** Compiler flags for `cl`, which takes neither `-o` nor a separate output argument. */
const msvc: ComputeRunCommand = {
  command: "cl",
  args: ["/nologo", "/Fe:{output}", "{file}"],
  build: {},
};

/**
 * Every language that runs from its file. Python, R, Julia, SQL and MATLAB have sessions of their
 * own. A file type two languages share goes to the first one listed here.
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
    commands: [compiled("clang"), compiled("gcc"), compiled("cc"), msvc],
  },
  {
    languageId: "cpp",
    extensions: [".cpp", ".cc", ".cxx"],
    commands: [compiled("clang++"), compiled("g++"), compiled("c++"), msvc],
  },
  {
    languageId: "fortran",
    extensions: [".f90", ".f95", ".f03", ".f08", ".f"],
    commands: ["gfortran", "ifx", "ifort", "flang", "nvfortran", "lfortran"].map(compiled),
  },
  { languageId: "rust", extensions: [".rs"], commands: [compiled("rustc")] },
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
  { languageId: "gnuplot", extensions: [".plt", ".gnu"], commands: [file("gnuplot")] },
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
  { languageId: "prolog", extensions: [".plg"], commands: [file("swipl")] },
  {
    languageId: "apl",
    extensions: [".apl"],
    commands: [file("dyalogscript"), file("apl", "--script")],
  },
  {
    languageId: "verilog",
    extensions: [".sv", ".vh"],
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
];

/** The route for a file. An extension with capitals, like ROOT's `.C`, matches only exactly. */
export function computeRunRouteForPath(path: string): ComputeRunRoute | undefined {
  const lower = path.toLowerCase();
  const matching = (accepts: (extension: string) => boolean) =>
    COMPUTE_RUN_TABLE.find((route) => route.extensions.some(accepts));
  return (
    matching((extension) => extension !== extension.toLowerCase() && path.endsWith(extension)) ??
    matching((extension) => lower.endsWith(extension))
  );
}

/**
 * What Run can start for a language, best first. The first one runs a file unless someone chooses
 * another. An app bundle proves the language is here, but it is not a program Run can start.
 */
export function computeRunnableTools<
  Tool extends { readonly name: string; readonly executable: string },
>(route: ComputeRunRoute, tools: ReadonlyArray<Tool>): ReadonlyArray<Tool> {
  return route.commands.flatMap((command) =>
    tools.filter((tool) => tool.name === command.command && !/\.app$/iu.test(tool.executable)),
  );
}
