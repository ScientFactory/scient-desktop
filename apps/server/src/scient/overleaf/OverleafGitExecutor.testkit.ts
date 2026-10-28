// @effect-diagnostics nodeBuiltinImport:off -- Builds the shipped helper in an isolated test directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { make, OverleafGitExecutor } from "./OverleafGitExecutor.ts";

export function windowsCompilerCommand(command: string, cwd: string) {
  const vswhere = NodePath.join(
    process.env["ProgramFiles(x86)"]!,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const installation = NodeChildProcess.execFileSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8" },
  ).trim();
  const compiler = NodePath.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const result = NodeChildProcess.spawnSync(
    process.env.COMSPEC ?? "cmd.exe",
    ["/d", "/s", "/c", `"call "${compiler}" >nul && ${command}"`],
    { stdio: "inherit", cwd, windowsVerbatimArguments: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Windows test compilation failed (exit ${result.status}).`);
}

export const withExecutor = <A, E>(
  body: (input: {
    readonly git: OverleafGitExecutor["Service"];
    readonly runtimeRoot: string;
    readonly publicationHelper: string | undefined;
    readonly work: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options: {
    readonly allowLocalProtocols?: boolean;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "scient-overleaf-git-" }),
        (directory) =>
          Effect.promise(() =>
            NodeFSP.rm(directory, {
              recursive: true,
              force: true,
              // Windows can keep a killed child's cwd handle busy during process retirement.
              maxRetries: HostProcess.Platform.defaultValue() === "win32" ? 5 : 0,
            }),
          ),
      );
      const runtimeRoot = NodePath.join(root, "runtime");
      const work = NodePath.join(root, "work");
      yield* fs.makeDirectory(work);
      const publicationHelper =
        HostProcess.Platform.defaultValue() === "win32"
          ? yield* Effect.promise(() => filePublicationTestHelper())
          : undefined;
      const git = yield* make({ runtimeRoot, publicationHelper, ...options });
      return yield* body({ git, runtimeRoot, work, publicationHelper });
    }),
  ).pipe(Effect.provide(NodeServices.layer));
