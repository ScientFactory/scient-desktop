// @effect-diagnostics nodeBuiltinImport:off -- Builds the shipped helper in an isolated test directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeAll, afterAll } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  NodeChildProcess.execFileSync(
    process.env.COMSPEC ?? "cmd.exe",
    ["/d", "/s", "/c", `"call "${compiler}" >nul && ${command}"`],
    { stdio: "inherit", cwd, windowsVerbatimArguments: true },
  );
}

let buildDirectory: string | undefined;
afterAll(async () => {
  if (buildDirectory !== undefined)
    await NodeFSP.rm(buildDirectory, { recursive: true, force: true });
});
beforeAll(async () => {
  if (HostProcess.Platform.defaultValue() !== "win32") return;
  const destination = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-git-helper-"));
  buildDirectory = destination;
  // The ordinary resolver consumes the shipped helper; the test never substitutes a mock boundary.
  const target = NodePath.resolve(
    import.meta.dirname,
    "../../../../../native/file-exchange/win32-x64",
  );
  windowsCompilerCommand(
    `"${process.execPath}" "${NodePath.resolve(import.meta.dirname, "../../../../../scripts/stage-file-exchange.ts")}" --destination="${target}"`,
    destination,
  );
});

export const withExecutor = <A, E>(
  body: (input: {
    readonly git: OverleafGitExecutor["Service"];
    readonly runtimeRoot: string;
    readonly work: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options: {
    readonly allowLocalProtocols?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-git-" });
      const runtimeRoot = NodePath.join(root, "runtime");
      const work = NodePath.join(root, "work");
      yield* fs.makeDirectory(work);
      const git = yield* make({ runtimeRoot, ...options }).pipe(
        Effect.provideService(HostProcess.Environment, options.environment ?? process.env),
      );
      return yield* body({ git, runtimeRoot, work });
    }),
  ).pipe(Effect.provide(NodeServices.layer));
