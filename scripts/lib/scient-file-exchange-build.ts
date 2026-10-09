// @effect-diagnostics nodeBuiltinImport:off -- Host compiler adapter used by desktop staging.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Schema from "effect/Schema";

export const FILE_EXCHANGE_RESOURCE = {
  from: "apps/desktop/prod-resources/file-exchange",
  to: "file-exchange",
} as const;

/** Validate the final Electron layout, including architecture, outside app.asar. */
export async function validatePackagedFileExchange(
  app: string,
  arch: BuildFileExchangeInput["arch"],
): Promise<void> {
  const directory = NodePath.join(app, "Contents/Resources/file-exchange");
  const helper = NodePath.join(directory, "scient-file-exchange");
  const info = await NodeFSP.lstat(helper);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0)
    throw new Error("Packaged file exchange is not a regular executable.");
  const receipt = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        schemaVersion: Schema.Literal(1),
        component: Schema.Literal("scient-file-exchange"),
        protocolVersion: Schema.Literal(1),
        platform: Schema.Literal("darwin"),
        arch: Schema.Literals(["arm64", "x64", "universal"]),
      }),
    ),
  )(await NodeFSP.readFile(NodePath.join(directory, "provenance.json"), "utf8"));
  if (receipt.arch !== arch)
    throw new Error("Packaged file exchange receipt has the wrong architecture.");
  const actual = NodeChildProcess.execFileSync("lipo", ["-archs", helper], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .trim()
    .split(/\s+/u)
    .sort();
  const expected = (
    arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : "arm64"]
  ).sort();
  if (actual.join(" ") !== expected.join(" "))
    throw new Error("Packaged file exchange has the wrong architecture.");
  if (arch === "universal" || arch === HostProcessArchitecture.defaultValue()) {
    const version = NodeChildProcess.execFileSync(helper, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (version !== "scient-file-exchange/1")
      throw new Error("Packaged file exchange has an incompatible protocol.");
  }
}

export interface BuildFileExchangeInput {
  readonly repoRoot: string;
  readonly outputDirectory: string;
  readonly platform: "darwin" | "linux";
  readonly arch: "arm64" | "x64" | "universal";
}

/** Compile from the owned source for the requested target; never reuse a stale binary. */
export async function buildFileExchange(input: BuildFileExchangeInput): Promise<string> {
  if (HostProcessPlatform.defaultValue() !== input.platform) {
    throw new Error("File exchange must be built on its target operating system.");
  }
  if (input.platform === "linux" && input.arch !== HostProcessArchitecture.defaultValue()) {
    throw new Error("Linux file exchange must be built for the host architecture.");
  }
  const source = NodePath.join(input.repoRoot, "native/file-exchange/exchange.c");
  await NodeFSP.mkdir(input.outputDirectory, { recursive: true });
  const scratch = await NodeFSP.mkdtemp(NodePath.join(input.outputDirectory, ".compile-"));
  const binary = NodePath.join(scratch, "scient-file-exchange");
  try {
    NodeChildProcess.execFileSync(
      "cc",
      [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fstack-protector-strong",
        ...(input.platform === "darwin"
          ? [
              "-mmacosx-version-min=12.0",
              ...(input.arch === "universal"
                ? ["arm64", "x86_64"]
                : [input.arch === "x64" ? "x86_64" : "arm64"]
              ).flatMap((arch) => ["-arch", arch]),
            ]
          : []),
        source,
        "-o",
        binary,
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    if (input.platform === "darwin") {
      const actual = NodeChildProcess.execFileSync("lipo", ["-archs", binary], {
        encoding: "utf8",
        timeout: 10_000,
      })
        .trim()
        .split(/\s+/u)
        .sort();
      const expected = (
        input.arch === "universal"
          ? ["arm64", "x86_64"]
          : [input.arch === "x64" ? "x86_64" : "arm64"]
      ).sort();
      if (actual.join(" ") !== expected.join(" "))
        throw new Error("Wrong file exchange architecture.");
    }
    const bytes = await NodeFSP.readFile(binary);
    await NodeFSP.chmod(binary, 0o755);
    const destination = NodePath.join(input.outputDirectory, "scient-file-exchange");
    await NodeFSP.rename(binary, destination);
    await NodeFSP.writeFile(
      NodePath.join(input.outputDirectory, "provenance.json"),
      JSON.stringify({
        schemaVersion: 1,
        component: "scient-file-exchange",
        protocolVersion: 1,
        platform: input.platform,
        arch: input.arch,
        sourceSha256: NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(source))
          .digest("hex"),
        unsignedBinarySha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      }) + "\n",
    );
    return destination;
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

/** Only macOS is a qualified packaging target for the first manual-sync delivery. */
export async function stageFileExchangeForDesktopBuild(input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: "mac" | "linux" | "win";
  readonly arch: "arm64" | "x64" | "universal";
}): Promise<void> {
  const directory = NodePath.join(input.stageResourcesDir, FILE_EXCHANGE_RESOURCE.to);
  await NodeFSP.rm(directory, { recursive: true, force: true });
  if (input.platform !== "mac") return;
  await buildFileExchange({
    repoRoot: input.repoRoot,
    outputDirectory: directory,
    platform: "darwin",
    arch: input.arch,
  });
}
