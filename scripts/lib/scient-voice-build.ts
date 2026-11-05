// @effect-diagnostics nodeBuiltinImport:off -- isolated subprocess adapter invoked by the Effect build orchestrator.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isStagedWhisperRuntime } from "./whisper-runtime-receipt.ts";

export interface StageScientVoiceRuntimeInput {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: "linux" | "mac" | "win";
  readonly arch: "arm64" | "x64" | "universal";
  /** A runtime staged earlier, for example by a parallel CI job; verified before use. */
  readonly sourceDirectory?: string | undefined;
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
  if (input.sourceDirectory !== undefined) {
    // The receipt pins the whisper.cpp commit, build and every file's size and checksum.
    const verify = (directory: string) =>
      isStagedWhisperRuntime(directory, input.platform, input.arch).then((verified) => {
        if (!verified)
          throw new Error(`${directory} is not the verified whisper.cpp runtime for this target.`);
      });
    await verify(input.sourceDirectory);
    await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
    await NodeFSP.cp(input.sourceDirectory, outputDirectory, { recursive: true });
    await verify(outputDirectory);
  } else {
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
  }
  const executableName = input.platform === "win" ? "whisper-server.exe" : "whisper-server";
  await Promise.all(
    [executableName, "LICENSE.whisper.cpp", "provenance.json"].map((file) =>
      NodeFSP.access(NodePath.join(outputDirectory, file)),
    ),
  );
}
