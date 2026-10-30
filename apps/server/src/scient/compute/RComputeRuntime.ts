// @effect-diagnostics nodeBuiltinImport:off -- conventional R locations are host paths.
import * as NodePath from "node:path";

import { ComputeLanguageId } from "@scientfactory/compute";

import type { KernelLanguage } from "./KernelComputeRuntime.ts";

export const R_LANGUAGE_ID = ComputeLanguageId.make("r");

const R_FLAGS = ["--no-echo", "--no-save", "--no-restore"];

const PROBE = [
  "cat(",
  '  paste(R.version$major, R.version$minor, sep = "."),',
  "  R.version$arch,",
  '  normalizePath(R.home(), winslash = "/"),',
  '  if (nzchar(system.file(package = "IRkernel"))) as.character(packageVersion("IRkernel")) else "",',
  '  "",',
  '  sep = "\\n"',
  ")",
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
          {
            directory: NodePath.join(environment.ProgramFiles ?? "C:\\Program Files", "R"),
            prefix: "R-",
            relative: NodePath.join("bin", "R.exe"),
          },
        ]
      : platform === "darwin"
        ? [
            "R",
            "/opt/homebrew/bin/R",
            "/usr/local/bin/R",
            "/Library/Frameworks/R.framework/Resources/bin/R",
          ]
        : ["R", "/usr/local/bin/R", "/usr/bin/R"],
  probeArgs: [...R_FLAGS, "-e", PROBE],
  setup: (privateDirectory, environment) => ({
    args: [...R_FLAGS, "-e", SETUP, "--args", NodePath.join(privateDirectory, "library")],
    environment: { ...environment },
  }),
  launch: ({ executable, privateDirectory, environment, platform }) => ({
    argv: [executable, ...R_FLAGS, "-e", "IRkernel::main()", "--args", "{connection_file}"],
    // R_LIBS comes before the user's libraries, so only the kernel's packages are added.
    environment:
      privateDirectory === null
        ? {}
        : {
            R_LIBS: [NodePath.join(privateDirectory, "library"), environment.R_LIBS]
              .filter(Boolean)
              .join(platform === "win32" ? ";" : ":"),
          },
  }),
  interruptMode: () => "signal",
};
