// @effect-diagnostics nodeBuiltinImport:off -- isolated subprocess adapter invoked by the Effect build orchestrator.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface StageScientVoiceRuntimeInput {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: "linux" | "mac" | "win";
  readonly arch: "arm64" | "x64" | "universal";
  readonly verbose: boolean;
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`),
        );
    });
  });
}

/** Scient-owned packaging adapter kept outside T3's artifact orchestrator. */
export async function stageScientVoiceRuntimeForDesktopBuild(
  input: StageScientVoiceRuntimeInput,
): Promise<void> {
  const outputDirectory = NodePath.join(input.stageResourcesDir, "whisper-runtime");
  const stageScript = NodePath.join(input.repoRoot, "scripts/stage-whisper-runtime.ts");
  await run(
    process.execPath,
    [
      stageScript,
      "--platform",
      input.platform,
      "--arch",
      input.arch,
      "--output",
      outputDirectory,
      ...(input.verbose ? ["--verbose"] : []),
    ],
    input.repoRoot,
  );
  const executableName = input.platform === "win" ? "whisper-server.exe" : "whisper-server";
  await Promise.all(
    [executableName, "LICENSE.whisper.cpp", "provenance.json"].map((file) =>
      NodeFSP.access(NodePath.join(outputDirectory, file)),
    ),
  );
}
