// @effect-diagnostics nodeBuiltinImport:off -- isolated subprocess adapter invoked by the Effect build orchestrator.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

type BuildPlatform = "linux" | "mac" | "win";
type BuildArch = "arm64" | "x64" | "universal";

const RuntimeReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  component: Schema.Literal("synctex"),
  platformKey: Schema.String,
  files: Schema.Array(
    Schema.Struct({ file: Schema.String, sha256: Schema.String, size: Schema.Number }),
  ),
});
const decodeRuntimeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeReceipt));

export interface StageScientSyncTexRuntimeInput {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly sourceDirectory?: string;
  readonly verbose: boolean;
}

function executableName(platform: BuildPlatform): string {
  return platform === "win" ? "synctex.exe" : "synctex";
}

function platformKey(platform: BuildPlatform, arch: BuildArch): string {
  const processPlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${processPlatform}-${arch}`;
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

async function verifyRuntimeDirectory(
  directory: string,
  platform: BuildPlatform,
  arch: BuildArch,
): Promise<void> {
  const requiredFiles = [
    executableName(platform),
    "LICENSE.synctex",
    "LICENSE.zlib",
    "provenance.json",
  ];
  await Promise.all(requiredFiles.map((file) => NodeFSP.access(NodePath.join(directory, file))));
  const receipt = decodeRuntimeReceipt(
    await NodeFSP.readFile(NodePath.join(directory, "provenance.json"), "utf8"),
  );
  if (receipt.platformKey !== platformKey(platform, arch)) {
    throw new Error("The SyncTeX runtime provenance receipt is invalid for this build target.");
  }
  for (const fileName of requiredFiles.filter((file) => file !== "provenance.json")) {
    const entry = receipt.files.find((candidate) => candidate.file === fileName);
    if (entry === undefined) {
      throw new Error(`The SyncTeX runtime receipt does not describe ${fileName}.`);
    }
    const bytes = await NodeFSP.readFile(NodePath.join(directory, fileName));
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (entry.size !== bytes.byteLength || entry.sha256 !== digest) {
      throw new Error(`The SyncTeX runtime file ${fileName} failed integrity verification.`);
    }
  }
}

/** Scient-owned packaging adapter kept outside T3's artifact orchestrator. */
export async function stageScientSyncTexRuntimeForDesktopBuild(
  input: StageScientSyncTexRuntimeInput,
): Promise<void> {
  const outputDirectory = NodePath.join(input.stageResourcesDir, "synctex-runtime");
  if (input.sourceDirectory !== undefined) {
    await verifyRuntimeDirectory(input.sourceDirectory, input.platform, input.arch);
    await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
    await NodeFSP.cp(input.sourceDirectory, outputDirectory, { recursive: true });
  } else {
    const stageScript = NodePath.join(input.repoRoot, "scripts/stage-synctex-runtime.ts");
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
  await verifyRuntimeDirectory(outputDirectory, input.platform, input.arch);
}
