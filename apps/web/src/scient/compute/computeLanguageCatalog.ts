export interface ComputeCatalogLanguage {
  /** What a kernel for this language calls it, so a found kernel lands on this language's row. */
  readonly languageId: string;
  readonly name: string;
}

export interface ComputeCatalogGroup {
  readonly title: string;
  readonly languages: ReadonlyArray<ComputeCatalogLanguage>;
}

/**
 * Every language Scient names, each in one place. The first group crosses fields; the rest are one
 * field each, alphabetical, and leave out what the first group has.
 */
export const COMPUTE_LANGUAGE_CATALOG: ReadonlyArray<ComputeCatalogGroup> = [
  {
    title: "Most used",
    languages: [
      { languageId: "python", name: "Python" },
      { languageId: "r", name: "R" },
      { languageId: "matlab", name: "MATLAB" },
      { languageId: "sql", name: "SQL" },
      { languageId: "julia", name: "Julia" },
      { languageId: "stata", name: "Stata" },
      { languageId: "bash", name: "Bash" },
      { languageId: "cpp", name: "C++" },
      { languageId: "spss", name: "SPSS" },
      { languageId: "javascript", name: "JavaScript" },
      { languageId: "c", name: "C" },
      { languageId: "fortran", name: "Fortran" },
    ],
  },
  {
    title: "Statistics and social science",
    languages: [
      { languageId: "jags", name: "JAGS" },
      { languageId: "mplus", name: "Mplus" },
      { languageId: "netlogo", name: "NetLogo" },
      { languageId: "sas", name: "SAS" },
      { languageId: "stan", name: "Stan" },
    ],
  },
  {
    title: "Life sciences and medicine",
    languages: [
      { languageId: "imagej-macro", name: "ImageJ Macro" },
      { languageId: "nextflow", name: "Nextflow" },
      { languageId: "snakemake", name: "Snakemake" },
    ],
  },
  {
    title: "Mathematics",
    languages: [
      { languageId: "agda", name: "Agda" },
      { languageId: "gap", name: "GAP" },
      { languageId: "isabelle", name: "Isabelle" },
      { languageId: "lean", name: "Lean" },
      { languageId: "macaulay2", name: "Macaulay2" },
      { languageId: "magma", name: "Magma" },
      { languageId: "maple", name: "Maple" },
      { languageId: "maxima", name: "Maxima" },
      { languageId: "gp", name: "PARI/GP" },
      { languageId: "coq", name: "Rocq" },
      { languageId: "sage", name: "SageMath" },
      { languageId: "singular", name: "Singular" },
      { languageId: "wolfram-language", name: "Wolfram Language" },
    ],
  },
  {
    title: "Physics and astronomy",
    languages: [
      { languageId: "gnuplot", name: "gnuplot" },
      { languageId: "idl", name: "IDL" },
      { languageId: "root", name: "ROOT" },
    ],
  },
  {
    title: "Engineering and optimization",
    languages: [
      { languageId: "ampl", name: "AMPL" },
      { languageId: "gams", name: "GAMS" },
      { languageId: "octave", name: "GNU Octave" },
      { languageId: "minizinc", name: "MiniZinc" },
      { languageId: "modelica", name: "Modelica" },
      { languageId: "scilab", name: "Scilab" },
      { languageId: "verilog", name: "Verilog" },
      { languageId: "vhdl", name: "VHDL" },
    ],
  },
  {
    title: "Computer science",
    languages: [
      { languageId: "apl", name: "APL" },
      { languageId: "csharp", name: "C#" },
      { languageId: "clojure", name: "Clojure" },
      { languageId: "common-lisp", name: "Common Lisp" },
      { languageId: "elixir", name: "Elixir" },
      { languageId: "erlang", name: "Erlang" },
      { languageId: "fsharp", name: "F#" },
      { languageId: "go", name: "Go" },
      { languageId: "haskell", name: "Haskell" },
      { languageId: "java", name: "Java" },
      { languageId: "kotlin", name: "Kotlin" },
      { languageId: "lua", name: "Lua" },
      { languageId: "nim", name: "Nim" },
      { languageId: "ocaml", name: "OCaml" },
      { languageId: "perl", name: "Perl" },
      { languageId: "powershell", name: "PowerShell" },
      { languageId: "prolog", name: "Prolog" },
      { languageId: "racket", name: "Racket" },
      { languageId: "ruby", name: "Ruby" },
      { languageId: "rust", name: "Rust" },
      { languageId: "scala", name: "Scala" },
      { languageId: "tcl", name: "Tcl" },
      { languageId: "typescript", name: "TypeScript" },
      { languageId: "zig", name: "Zig" },
    ],
  },
];
