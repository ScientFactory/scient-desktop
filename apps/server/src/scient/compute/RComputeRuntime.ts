// @effect-diagnostics nodeBuiltinImport:off -- conventional R locations are host paths.
import * as NodePath from "node:path";

import { ComputeLanguageId } from "@scientfactory/compute";

import { ARK_VERSION, arkProgram, installArk } from "./ArkKernel.ts";
import { KERNEL_PROBE_MARKER, type KernelLanguage } from "./KernelComputeRuntime.ts";
import { readRFacts, rPackageVersion } from "./RuntimeFacts.ts";

const R_LANGUAGE_ID = ComputeLanguageId.make("r");

const R_FLAGS = ["--no-echo", "--no-save", "--no-restore"];
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

function libraryPath(
  platform: NodeJS.Platform,
  home: string,
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const name =
    platform === "linux" ? "LD_LIBRARY_PATH" : platform === "darwin" ? "DYLD_LIBRARY_PATH" : null;
  if (name === null) return {};
  const existing = environment[name];
  const lib = `${home}/lib`;
  return { [name]: existing ? `${lib}:${existing}` : lib };
}

export const R_KERNEL_LANGUAGE: KernelLanguage = {
  languageId: R_LANGUAGE_ID,
  displayName: "R",
  kernelLanguage: "R",
  programName: "r",
  kernelPackage: "Ark",
  ownKernelName: "IRkernel",
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
  registered: async (context) =>
    (await context.host.windowsInstallRoots("r")).map((root) =>
      NodePath.win32.join(root, "bin", "R.exe"),
    ),
  // R.exe hands its arguments to cmd.exe, which stops at the first line break and reads the rest as
  // shell syntax, and it leaves the real process a grandchild that nothing can stop.
  program: (context, executable) => {
    if (context.platform !== "win32") return executable;
    const folder = NodePath.win32.dirname(executable);
    return (
      [
        NodePath.win32.join(folder, "x64", "Rterm.exe"),
        NodePath.win32.join(folder, "Rterm.exe"),
      ].find((path) => context.host.kind(path) === "file") ?? executable
    );
  },
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
  setup: { version: ARK_VERSION, add: installArk },
  // IRkernel answers no interrupt on Windows, so Ark runs there even for people who have IRkernel.
  ownKernelUsable: (platform) => platform !== "win32",
  launch: ({ executable, privateDirectory, environment, platform, home }) =>
    privateDirectory === null
      ? {
          argv: [executable, ...R_FLAGS, "-e", "IRkernel::main()", "--args", "{connection_file}"],
          environment: {},
        }
      : {
          argv: [
            arkProgram(privateDirectory, platform),
            "--connection_file",
            "{connection_file}",
            // Console mode prints every top-level value, as R does; notebook mode only the last.
            "--session-mode",
            "console",
            // Keep the person's own CRAN setting.
            "--default-repos",
            "none",
            "--",
            "--interactive",
          ],
          environment: {
            R_HOME: home,
            RUST_LOG: "error",
            // R's launcher script sets these for R; Ark loads R's libraries itself.
            ...libraryPath(platform, home, environment),
          },
          interruptMode: "message",
          interruptedReplyIsOk: true,
        },
  interruptMode: () => "signal",
};
