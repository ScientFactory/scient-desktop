// @effect-diagnostics nodeBuiltinImport:off -- conventional Julia locations are host paths.
import * as NodePath from "node:path";

import { ComputeLanguageId } from "@scientfactory/compute";

import { KERNEL_PROBE_MARKER, type KernelLanguage } from "./KernelComputeRuntime.ts";
import { juliaPackagePresent, readJuliaFacts } from "./RuntimeFacts.ts";

const JULIA_LANGUAGE_ID = ComputeLanguageId.make("julia");

const JULIA_FLAGS = ["--startup-file=no", "--history-file=no"];

// Read from IJulia's Project.toml with the reader Julia's code loading uses: `pkgversion` needs
// Julia 1.9, and `Base.TOML.parsefile` exists on no current version, so a probe that found the
// person's own IJulia failed.
const packageVersion = (path: string) =>
  `get(Base.parsed_toml(joinpath(dirname(dirname(${path})), "Project.toml")), "version", "unknown")`;

const PROBE = [
  'let p = Base.find_package("IJulia")',
  `  kernel = p === nothing ? "" : ${packageVersion("p")}`,
  `  println(join(["${KERNEL_PROBE_MARKER}", VERSION, Sys.ARCH, Sys.BINDIR, kernel], '\\t'))`,
  "end",
].join("\n");

const PATH_SEPARATOR = 'Sys.iswindows() ? ";" : ":"';

// Julia keeps its standard library compiled in its installation's depots. Setup names Scient's
// depot alone, because an empty entry also brings in the person's ~/.julia before Julia 1.11, so
// these are added here, as Julia adds them itself, and passed on to the processes Pkg starts.
// Without them every first setup compiled the standard library again: one to four minutes.
const BUNDLED_DEPOTS = [
  'for depot in (abspath(Sys.BINDIR, "..", "local", "share", "julia"), abspath(Sys.BINDIR, Base.DATAROOTDIR, "julia"))',
  "  depot in DEPOT_PATH || push!(DEPOT_PATH, depot)",
  "end",
  `ENV["JULIA_DEPOT_PATH"] = join(DEPOT_PATH, ${PATH_SEPARATOR})`,
].join("; ");

const SETUP = [
  BUNDLED_DEPOTS,
  "using Pkg",
  'Pkg.add("IJulia")',
  "Pkg.precompile()",
  "import IJulia",
  "println()",
  `println(${packageVersion('Base.find_package("IJulia")')})`,
].join("; ");

// Scient's depot and environment go after the person's, which stay first and keep receiving their
// package changes. Julia adds them itself, from the two arguments ahead of the connection file:
// an empty JULIA_DEPOT_PATH entry stands for the person's ~/.julia on most versions, but 1.11.0
// and 1.11.1 expand it to the installation's depots alone.
const WITH_SCIENT_KERNEL = [
  "let depot = popfirst!(ARGS), environment = popfirst!(ARGS)",
  "  depot in DEPOT_PATH || push!(DEPOT_PATH, depot)",
  "  environment in LOAD_PATH || push!(LOAD_PATH, environment)",
  `  ENV["JULIA_DEPOT_PATH"] = join(DEPOT_PATH, ${PATH_SEPARATOR})`,
  `  ENV["JULIA_LOAD_PATH"] = join(LOAD_PATH, ${PATH_SEPARATOR})`,
  "end",
].join("\n");

// The IJulia an older Julia installs (1.26 on Julia 1.8) has no `run_kernel`; its kernel is the
// script its kernelspec starts.
const RUN_KERNEL =
  'import IJulia; isdefined(IJulia, :run_kernel) ? IJulia.run_kernel() : include(joinpath(dirname(pathof(IJulia)), "kernel.jl"))';

// Summarizes Main without calling user-defined show methods: only built-in scalars get a preview.
const VARIABLES = String.raw`let j(s) = "\"" * join(c == '"' ? "\\\"" : c == '\\' ? "\\\\" : c < ' ' ? "\\u" * string(UInt16(c), base = 16, pad = 4) : string(c) for c in s) * "\"",
    o(x) = x === nothing ? "null" : x isa Integer ? string(x) : j(x),
    plain(v) = v isa Union{Real, Complex, Symbol, Nothing, Missing} && parentmodule(typeof(v)) in (Base, Core),
    hidden = (:Base, :Core, :Main, :ans, :In, :Out, :IJulia, :InteractiveUtils, :include, :eval),
    names_ = sort!([n for n in names(Main; all = true) if isdefined(Main, n) && !(n in hidden) && !startswith(string(n), r"[#_]") && !(getfield(Main, n) isa Union{Module, Function, Type})])
  Text("{\"variables\":[" * join((let v = getfield(Main, n)
      "{\"name\":" * j(string(n)) * ",\"typeName\":" * j(first(string(typeof(v)), 256)) *
      ",\"shape\":" * o(v isa AbstractArray ? string(size(v)) : nothing) *
      ",\"size\":" * o(v isa Union{AbstractArray, AbstractString, AbstractDict, AbstractSet, Tuple} ? length(v) : nothing) *
      ",\"preview\":" * o(plain(v) ? first(repr(v), 4096) : v isa String ? first(repr(first(v, 160)), 4096) : nothing) * "}"
    end for n in first(names_, 201)), ",") * "],\"truncated\":false}")
end`;

export const JULIA_KERNEL_LANGUAGE: KernelLanguage = {
  languageId: JULIA_LANGUAGE_ID,
  displayName: "Julia",
  kernelLanguage: "julia",
  programName: "julia",
  kernelPackage: "IJulia",
  ownKernelName: "IJulia",
  sourceExtensions: [".jl"],
  variablesExpression: VARIABLES,
  // A first session may still compile code IJulia did not precompile.
  startupTimeoutMs: 120_000,
  candidates: (platform, environment) => {
    const home = environment.HOME ?? environment.USERPROFILE;
    const juliaup = home === undefined ? [] : [NodePath.join(home, ".juliaup", "bin", "julia")];
    if (platform === "win32") {
      const local = environment.LOCALAPPDATA;
      return [
        "julia.exe",
        ...juliaup.map((path) => `${path}.exe`),
        ...(local === undefined
          ? []
          : [
              NodePath.join(local, "Microsoft", "WindowsApps", "julia.exe"),
              {
                directory: NodePath.join(local, "Programs"),
                prefix: "Julia-",
                relative: NodePath.join("bin", "julia.exe"),
              },
            ]),
      ];
    }
    return platform === "darwin"
      ? [
          "julia",
          ...juliaup,
          "/opt/homebrew/bin/julia",
          "/usr/local/bin/julia",
          ...[
            "/Applications",
            ...(home === undefined ? [] : [NodePath.join(home, "Applications")]),
          ].map((directory) => ({
            directory,
            prefix: "Julia-",
            relative: "Contents/Resources/julia/bin/julia",
          })),
        ]
      : [
          "julia",
          ...juliaup,
          "/usr/local/bin/julia",
          "/usr/bin/julia",
          { directory: "/opt", prefix: "julia-", relative: "bin/julia" },
        ];
  },
  probeArgs: [...JULIA_FLAGS, "-e", PROBE],
  readFacts: (context, executable) => {
    const facts = readJuliaFacts(context, executable);
    return {
      version: facts.version,
      architecture: null,
      ownKernelVersion: juliaPackagePresent(context, facts, "IJulia") ? "installed" : null,
    };
  },
  inEnvironment: () => ["bin/julia"],
  setup: (privateDirectory, environment, platform) => ({
    args: [...JULIA_FLAGS, "-e", SETUP],
    // Only Scient's depot and project are written; no kernelspec is registered with Jupyter.
    environment: {
      ...environment,
      JULIA_DEPOT_PATH: NodePath.join(privateDirectory, "depot"),
      JULIA_PROJECT: NodePath.join(privateDirectory, "environment"),
      JULIA_LOAD_PATH: `@${platform === "win32" ? ";" : ":"}@stdlib`,
      JUPYTER_DATA_DIR: NodePath.join(privateDirectory, "jupyter"),
      IJULIA_NODEFAULTKERNEL: "1",
    },
  }),
  launch: ({ executable, privateDirectory, environment }) => ({
    argv:
      privateDirectory === null
        ? [executable, "-i", "--color=yes", "-e", RUN_KERNEL, "{connection_file}"]
        : [
            executable,
            "-i",
            "--color=yes",
            "-e",
            `${WITH_SCIENT_KERNEL}\n${RUN_KERNEL}`,
            NodePath.join(privateDirectory, "depot"),
            NodePath.join(privateDirectory, "environment"),
            "{connection_file}",
          ],
    // The project folder's Project.toml, unless the person already named an environment.
    environment: environment.JULIA_PROJECT ? {} : { JULIA_PROJECT: "@." },
  }),
  interruptMode: (platform) => (platform === "win32" ? "message" : "signal"),
};
