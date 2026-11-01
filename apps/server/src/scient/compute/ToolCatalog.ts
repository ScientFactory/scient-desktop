/**
 * How to find each language's own tools; nothing here is ever started. Python, R, Julia and MATLAB
 * search for themselves. In `places`, `*` matches one folder level, `~` is the home folder and
 * `%NAME%` an environment variable.
 */
/** Where people move these tools. Started from Finder, Scient sees them only through the login shell. */
export const DISCOVERY_VARIABLES = [
  "ASDF_DATA_DIR",
  "CARGO_HOME",
  "CONDA_EXE",
  "ELAN_HOME",
  "JULIAUP_DEPOT_PATH",
  "JULIA_DEPOT_PATH",
  "JUPYTER_DATA_DIR",
  "JUPYTER_PATH",
  "MAMBA_ROOT_PREFIX",
  "MISE_DATA_DIR",
  "NVM_DIR",
  "OPAMROOT",
  "POETRY_VIRTUALENVS_PATH",
  "PYENV_ROOT",
  "RUSTUP_HOME",
  "R_LIBS",
  "R_LIBS_SITE",
  "R_LIBS_USER",
  "SDKMAN_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "WORKON_HOME",
] as const;

export interface LanguageTools {
  readonly commands: ReadonlyArray<string>;
  readonly places?: {
    readonly darwin?: ReadonlyArray<string>;
    readonly linux?: ReadonlyArray<string>;
    readonly win32?: ReadonlyArray<string>;
  };
  /** A folder that must sit beside the command, for a tool that is also shipped without it. */
  readonly beside?: string;
}

const DOTNET: LanguageTools = {
  commands: ["dotnet"],
  beside: "sdk",
  places: {
    darwin: ["/usr/local/share/dotnet/dotnet"],
    linux: ["/usr/share/dotnet/dotnet", "/usr/lib/dotnet/dotnet"],
    win32: ["%ProgramFiles%\\dotnet\\dotnet.exe"],
  },
};

const MSVC =
  "%ProgramFiles%\\Microsoft Visual Studio\\*\\*\\VC\\Tools\\MSVC\\*\\bin\\Hostx64\\x64\\cl.exe";

export const LANGUAGE_TOOLS: Readonly<Record<string, LanguageTools>> = {
  sql: { commands: ["duckdb", "sqlite3", "psql", "mysql"] },
  sqlite: { commands: ["sqlite3"] },
  bash: {
    commands: ["bash"],
    places: {
      win32: ["%ProgramFiles%\\Git\\bin\\bash.exe", "C:\\msys64\\usr\\bin\\bash.exe"],
    },
  },
  cpp: { commands: ["clang++", "g++", "c++", "cl"], places: { win32: [MSVC] } },
  c: { commands: ["clang", "gcc", "cc", "cl"], places: { win32: [MSVC] } },
  fortran: { commands: ["gfortran", "ifx", "ifort", "flang", "nvfortran", "lfortran"] },
  javascript: {
    commands: ["node", "deno", "bun"],
    places: { win32: ["%ProgramFiles%\\nodejs\\node.exe"] },
  },
  spss: {
    commands: ["stats", "pspp"],
    places: {
      darwin: [
        "/Applications/IBM SPSS Statistics*/*.app",
        "/Applications/IBM/SPSS/Statistics/*/*.app",
      ],
      linux: ["/opt/IBM/SPSS/Statistics/*/bin/stats"],
      win32: [
        "%ProgramFiles%\\IBM\\SPSS Statistics\\stats.exe",
        "%ProgramFiles%\\IBM\\SPSS\\Statistics\\*\\stats.exe",
      ],
    },
  },
  stata: {
    commands: ["stata-mp", "stata-se", "stata-be", "stata"],
    places: {
      darwin: ["/Applications/Stata*/Stata*.app/Contents/MacOS/stata*"],
      linux: ["/usr/local/stata*/stata-*"],
      win32: ["%ProgramFiles%\\Stata*\\Stata*.exe"],
    },
  },
  jags: {
    commands: ["jags"],
    places: { win32: ["%ProgramFiles%\\JAGS\\JAGS-*\\x64\\bin\\jags-terminal.exe"] },
  },
  mplus: {
    commands: ["mplus"],
    places: {
      darwin: ["/Applications/Mplus/mplus"],
      linux: ["/opt/mplus/*/mplus"],
      win32: ["%ProgramFiles%\\Mplus\\Mplus.exe"],
    },
  },
  netlogo: {
    commands: ["netlogo-headless", "NetLogo"],
    places: {
      darwin: ["/Applications/NetLogo*/NetLogo*.app"],
      linux: ["/opt/NetLogo*/NetLogo", "~/NetLogo*/NetLogo"],
      win32: ["%ProgramFiles%\\NetLogo*\\NetLogo.exe"],
    },
  },
  sas: {
    commands: ["sas"],
    places: {
      linux: ["/usr/local/SASHome/SASFoundation/*/sas", "/opt/sas/SASHome/SASFoundation/*/sas"],
      win32: ["%ProgramFiles%\\SASHome\\SASFoundation\\*\\sas.exe"],
    },
  },
  stan: {
    commands: ["stanc"],
    places: {
      darwin: ["~/.cmdstan/cmdstan-*/bin/stanc"],
      linux: ["~/.cmdstan/cmdstan-*/bin/stanc"],
      win32: ["~/.cmdstan/cmdstan-*/bin/stanc.exe"],
    },
  },
  "imagej-macro": {
    commands: ["fiji", "ImageJ"],
    places: {
      darwin: [
        "/Applications/Fiji.app/Contents/MacOS/ImageJ-macosx",
        "~/Applications/Fiji.app/Contents/MacOS/ImageJ-macosx",
        "/Applications/ImageJ.app/Contents/MacOS/*",
      ],
      linux: ["~/Fiji.app/ImageJ-linux64", "/opt/Fiji.app/ImageJ-linux64"],
      win32: ["~/Fiji.app/ImageJ-win64.exe", "%ProgramFiles%\\Fiji.app\\ImageJ-win64.exe"],
    },
  },
  nextflow: { commands: ["nextflow"] },
  snakemake: { commands: ["snakemake"] },
  agda: { commands: ["agda"] },
  gap: { commands: ["gap"] },
  isabelle: {
    commands: ["isabelle"],
    places: {
      darwin: ["/Applications/Isabelle*.app"],
      linux: ["~/Isabelle*/bin/isabelle"],
      win32: ["~/Isabelle*/Isabelle*.exe", "%ProgramFiles%\\Isabelle*\\Isabelle*.exe"],
    },
  },
  lean: { commands: ["lean", "lake"] },
  macaulay2: { commands: ["M2"] },
  magma: {
    commands: ["magma"],
    places: {
      darwin: ["/usr/local/magma/magma", "/Applications/Magma/magma"],
      linux: ["/usr/local/magma/magma", "/opt/magma/magma"],
      win32: ["%ProgramFiles%\\Magma\\magma.exe"],
    },
  },
  maple: {
    commands: ["maple"],
    places: {
      darwin: [
        "/Applications/Maple *.app",
        "/Library/Frameworks/Maple.framework/Versions/*/bin/maple",
      ],
      linux: ["/opt/maple*/bin/maple", "/usr/local/maple*/bin/maple"],
      win32: ["%ProgramFiles%\\Maple *\\bin.X86_64_WINDOWS\\cmaple.exe"],
    },
  },
  maxima: {
    commands: ["maxima"],
    places: { win32: ["%ProgramFiles%\\Maxima-*\\bin\\maxima.bat"] },
  },
  gp: { commands: ["gp"], places: { win32: ["%ProgramFiles%\\PARI*\\gp*.exe"] } },
  coq: {
    commands: ["rocq", "coqc"],
    places: { darwin: ["/Applications/Coq-Platform*.app", "/Applications/Rocq-Platform*.app"] },
  },
  sage: { commands: ["sage"], places: { darwin: ["/Applications/SageMath-*.app"] } },
  singular: { commands: ["Singular"] },
  "wolfram-language": {
    commands: ["wolframscript", "WolframKernel", "wolfram"],
    places: {
      darwin: ["/Applications/Wolfram*.app", "/Applications/Mathematica*.app"],
      linux: [
        "/usr/local/Wolfram/*/*/Executables/WolframKernel",
        "/opt/Wolfram/*/*/Executables/WolframKernel",
      ],
      win32: ["%ProgramFiles%\\Wolfram Research\\*\\*\\WolframKernel.exe"],
    },
  },
  gnuplot: {
    commands: ["gnuplot"],
    places: { win32: ["%ProgramFiles%\\gnuplot\\bin\\gnuplot.exe"] },
  },
  idl: {
    commands: ["idl", "gdl"],
    places: {
      darwin: ["/Applications/harris/idl*/bin/idl", "/Applications/NV5/idl*/bin/idl"],
      linux: ["/usr/local/harris/idl*/bin/idl", "/usr/local/nv5/idl*/bin/idl"],
      win32: [
        "%ProgramFiles%\\Harris\\IDL*\\bin\\bin.x86_64\\idl.exe",
        "%ProgramFiles%\\NV5\\IDL*\\bin\\bin.x86_64\\idl.exe",
      ],
    },
  },
  root: { commands: ["root", "root.exe"], places: { win32: ["C:\\root*\\bin\\root.exe"] } },
  ampl: { commands: ["ampl"] },
  gams: {
    commands: ["gams"],
    places: {
      darwin: ["/Library/Frameworks/GAMS.framework/Versions/*/Resources/gams"],
      linux: ["/opt/gams/gams*/gams"],
      win32: ["C:\\GAMS\\*\\gams.exe"],
    },
  },
  octave: {
    commands: ["octave-cli", "octave"],
    places: {
      darwin: ["/Applications/Octave-*.app"],
      win32: [
        "%ProgramFiles%\\GNU Octave\\Octave-*\\mingw64\\bin\\octave-cli.exe",
        "%LOCALAPPDATA%\\Programs\\GNU Octave\\Octave-*\\mingw64\\bin\\octave-cli.exe",
      ],
    },
  },
  minizinc: {
    commands: ["minizinc"],
    places: {
      darwin: ["/Applications/MiniZincIDE.app/Contents/Resources/minizinc"],
      win32: ["%ProgramFiles%\\MiniZinc\\minizinc.exe"],
    },
  },
  modelica: {
    commands: ["omc"],
    places: {
      darwin: ["/opt/openmodelica/bin/omc"],
      win32: ["%ProgramFiles%\\OpenModelica*\\bin\\omc.exe"],
    },
  },
  scilab: {
    commands: ["scilab-cli", "scilab"],
    places: {
      darwin: ["/Applications/scilab-*.app/Contents/bin/scilab-cli"],
      win32: ["%ProgramFiles%\\scilab-*\\bin\\WScilex-cli.exe"],
    },
  },
  verilog: { commands: ["iverilog", "verilator"] },
  vhdl: { commands: ["ghdl", "nvc"] },
  apl: {
    commands: ["dyalog", "dyalogscript", "apl"],
    places: {
      darwin: ["/Applications/Dyalog-*.app/Contents/Resources/Dyalog/mapl"],
      linux: ["/opt/mdyalog/*/*/*/dyalog"],
      win32: ["%ProgramFiles%\\Dyalog\\*\\dyalog.exe"],
    },
  },
  csharp: DOTNET,
  fsharp: DOTNET,
  clojure: { commands: ["clojure", "clj", "bb"] },
  "common-lisp": { commands: ["sbcl", "ccl", "clisp", "ecl"] },
  elixir: { commands: ["elixir"] },
  erlang: { commands: ["erl", "escript"] },
  go: { commands: ["go"], places: { win32: ["%ProgramFiles%\\Go\\bin\\go.exe"] } },
  haskell: { commands: ["ghc", "runghc"], places: { win32: ["C:\\ghcup\\bin\\ghc.exe"] } },
  java: {
    commands: ["javac", "java"],
    places: {
      darwin: ["/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/javac"],
      linux: ["/usr/lib/jvm/*/bin/javac"],
      win32: [
        "%ProgramFiles%\\Java\\*\\bin\\javac.exe",
        "%ProgramFiles%\\Eclipse Adoptium\\*\\bin\\javac.exe",
        "%ProgramFiles%\\Microsoft\\jdk-*\\bin\\javac.exe",
        "%ProgramFiles%\\Amazon Corretto\\*\\bin\\javac.exe",
      ],
    },
  },
  kotlin: { commands: ["kotlinc", "kotlin"] },
  lua: { commands: ["lua", "luajit", "lua5.4", "lua5.3"] },
  nim: { commands: ["nim"] },
  ocaml: { commands: ["ocaml", "ocamlc"] },
  perl: { commands: ["perl"], places: { win32: ["C:\\Strawberry\\perl\\bin\\perl.exe"] } },
  powershell: {
    commands: ["pwsh", "powershell"],
    places: { win32: ["%ProgramFiles%\\PowerShell\\*\\pwsh.exe"] },
  },
  prolog: {
    commands: ["swipl"],
    places: {
      darwin: ["/Applications/SWI-Prolog.app/Contents/MacOS/swipl"],
      win32: ["%ProgramFiles%\\swipl\\bin\\swipl.exe"],
    },
  },
  racket: {
    commands: ["racket"],
    places: {
      darwin: ["/Applications/Racket*/bin/racket"],
      win32: ["%ProgramFiles%\\Racket*\\Racket.exe"],
    },
  },
  ruby: { commands: ["ruby"], places: { win32: ["C:\\Ruby*\\bin\\ruby.exe"] } },
  rust: { commands: ["rustc", "cargo"] },
  scala: { commands: ["scala-cli", "scala", "scalac"] },
  tcl: { commands: ["tclsh", "tclsh9.0", "tclsh8.6"] },
  typescript: { commands: ["tsc", "deno", "bun"] },
  zig: { commands: ["zig"] },
};
