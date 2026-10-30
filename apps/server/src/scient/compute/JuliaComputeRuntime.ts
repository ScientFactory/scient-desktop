// @effect-diagnostics nodeBuiltinImport:off -- conventional Julia locations are host paths.
import * as NodePath from "node:path";

import { ComputeLanguageId } from "@scientfactory/compute";

import { KERNEL_PROBE_MARKER, type KernelLanguage } from "./KernelComputeRuntime.ts";

const JULIA_LANGUAGE_ID = ComputeLanguageId.make("julia");

const JULIA_FLAGS = ["--startup-file=no", "--history-file=no"];

const PROBE = [
  'let p = Base.find_package("IJulia")',
  '  kernel = p === nothing ? "" : get(Base.TOML.parsefile(joinpath(dirname(dirname(p)), "Project.toml")), "version", "unknown")',
  `  println(join(["${KERNEL_PROBE_MARKER}", VERSION, Sys.ARCH, Sys.BINDIR, kernel], '\\t'))`,
  "end",
].join("\n");

const SETUP = [
  "using Pkg",
  'Pkg.add("IJulia")',
  "Pkg.precompile()",
  "import IJulia",
  "println()",
  "println(pkgversion(IJulia))",
].join("; ");

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
  kernelPackage: "IJulia",
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
          {
            directory: "/Applications",
            prefix: "Julia-",
            relative: "Contents/Resources/julia/bin/julia",
          },
        ]
      : ["julia", ...juliaup, "/usr/local/bin/julia", "/usr/bin/julia"];
  },
  probeArgs: [...JULIA_FLAGS, "-e", PROBE],
  setup: (privateDirectory, environment) => ({
    args: [...JULIA_FLAGS, "-e", SETUP],
    // Only Scient's depot and project are written; no kernelspec is registered with Jupyter.
    environment: {
      ...environment,
      JULIA_DEPOT_PATH: NodePath.join(privateDirectory, "depot"),
      JULIA_PROJECT: NodePath.join(privateDirectory, "environment"),
      JULIA_LOAD_PATH: "@:@stdlib",
      JUPYTER_DATA_DIR: NodePath.join(privateDirectory, "jupyter"),
      IJULIA_NODEFAULTKERNEL: "1",
    },
  }),
  launch: ({ executable, privateDirectory, environment, platform }) => {
    const separator = platform === "win32" ? ";" : ":";
    return {
      argv: [
        executable,
        "-i",
        "--color=yes",
        "-e",
        "import IJulia; IJulia.run_kernel()",
        "{connection_file}",
      ],
      // An empty entry stands for Julia's defaults, so the user's own depot and environment stay
      // first and keep receiving their package changes.
      environment:
        privateDirectory === null
          ? {}
          : {
              JULIA_DEPOT_PATH: `${environment.JULIA_DEPOT_PATH ?? ""}${separator}${NodePath.join(privateDirectory, "depot")}`,
              JULIA_LOAD_PATH: `${environment.JULIA_LOAD_PATH ?? ""}${separator}${NodePath.join(privateDirectory, "environment")}`,
            },
    };
  },
  interruptMode: (platform) => (platform === "win32" ? "message" : "signal"),
};
