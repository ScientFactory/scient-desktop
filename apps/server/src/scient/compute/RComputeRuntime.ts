// @effect-diagnostics nodeBuiltinImport:off -- conventional R locations are host paths.
import * as NodePath from "node:path";

import { ComputeLanguageId } from "@scientfactory/compute";

import { KERNEL_PROBE_MARKER, type KernelLanguage } from "./KernelComputeRuntime.ts";
import { readRFacts, rPackageVersion } from "./RuntimeFacts.ts";

const R_LANGUAGE_ID = ComputeLanguageId.make("r");

const R_FLAGS = ["--no-echo", "--no-save", "--no-restore"];
/** The kernel's own library, added after the person's so their packages always win. */
const KERNEL_LIBRARY_VARIABLE = "COMPUTE_R_KERNEL_LIBRARY";

const PROBE = [
  "cat(",
  `  "${KERNEL_PROBE_MARKER}",`,
  '  paste(R.version$major, R.version$minor, sep = "."),',
  "  R.version$arch,",
  '  normalizePath(R.home(), winslash = "/"),',
  '  if (nzchar(system.file(package = "IRkernel"))) as.character(packageVersion("IRkernel")) else "",',
  '  sep = "\\t"',
  ")",
  'cat("\\n")',
].join("\n");

// Installs into Scient's library only; packages the user already has are reused, never replaced.
const SETUP = [
  "lib <- commandArgs(TRUE)[1]",
  "dir.create(lib, recursive = TRUE, showWarnings = FALSE)",
  ".libPaths(c(lib, .libPaths()))",
  'repos <- getOption("repos")',
  'if (is.null(repos) || is.na(repos["CRAN"]) || repos["CRAN"] == "@CRAN@")',
  '  repos["CRAN"] <- "https://cloud.r-project.org"',
  'install.packages("IRkernel", lib = lib, repos = repos, quiet = TRUE)',
  "suppressPackageStartupMessages(library(IRkernel))",
  'cat("\\n", as.character(packageVersion("IRkernel", lib.loc = lib)), "\\n", sep = "")',
].join("\n");

export const R_KERNEL_LANGUAGE: KernelLanguage = {
  languageId: R_LANGUAGE_ID,
  displayName: "R",
  kernelLanguage: "R",
  kernelPackage: "IRkernel",
  sourceExtensions: [".r"],
  // IRkernel does not evaluate Jupyter user expressions.
  variablesExpression: null,
  candidates: (platform, environment) =>
    platform === "win32"
      ? [
          "R.exe",
          // Machine-wide and per-user installers (and rig) use versioned R-x.y.z folders.
          ...[
            environment.ProgramFiles ?? "C:\\Program Files",
            ...(environment.LOCALAPPDATA === undefined
              ? []
              : [NodePath.win32.join(environment.LOCALAPPDATA, "Programs")]),
          ].map((root) => ({
            directory: NodePath.win32.join(root, "R"),
            prefix: "R-",
            relative: NodePath.win32.join("bin", "R.exe"),
          })),
        ]
      : platform === "darwin"
        ? [
            "R",
            "/opt/homebrew/bin/R",
            "/usr/local/bin/R",
            "/Library/Frameworks/R.framework/Resources/bin/R",
            // rig keeps several versions side by side.
            {
              directory: "/Library/Frameworks/R.framework/Versions",
              prefix: "",
              relative: "Resources/bin/R",
            },
          ]
        : [
            "R",
            "/usr/local/bin/R",
            "/usr/bin/R",
            { directory: "/opt/R", prefix: "", relative: "bin/R" },
          ],
  // A probe answers about R itself, so it skips the startup files a session would run.
  probeArgs: [...R_FLAGS, "--no-site-file", "--no-init-file", "-e", PROBE],
  readFacts: (context, executable) => {
    const facts = readRFacts(context, executable);
    return {
      version: facts.version,
      architecture: facts.architecture,
      ownKernelVersion: rPackageVersion(context, facts, "IRkernel"),
    };
  },
  inEnvironment: (platform) =>
    platform === "win32" ? [NodePath.join("Lib", "R", "bin", "R.exe")] : ["bin/R"],
  setup: (privateDirectory, environment) => ({
    args: [...R_FLAGS, "-e", SETUP, "--args", NodePath.join(privateDirectory, "library")],
    environment: { ...environment },
  }),
  launch: ({ executable, privateDirectory }) => ({
    argv: [
      executable,
      ...R_FLAGS,
      "-e",
      // After startup, because renv replaces the library paths while R starts.
      privateDirectory === null
        ? "IRkernel::main()"
        : `.libPaths(c(.libPaths(), Sys.getenv("${KERNEL_LIBRARY_VARIABLE}"))); IRkernel::main()`,
      "--args",
      "{connection_file}",
    ],
    environment:
      privateDirectory === null
        ? {}
        : { [KERNEL_LIBRARY_VARIABLE]: NodePath.join(privateDirectory, "library") },
  }),
  interruptMode: () => "signal",
};
