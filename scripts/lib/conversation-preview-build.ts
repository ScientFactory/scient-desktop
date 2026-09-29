// @effect-diagnostics nodeBuiltinImport:off -- subprocess adapter for the native artifact builder.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type ConversationPreviewChannel = "latest" | "nightly" | "preview";
export type ConversationPreviewArch = "arm64" | "x64" | "universal";

export const WINDOWS_PREVIEW_CLSIDS: Record<ConversationPreviewChannel, string> = {
  latest: "{E0C925A3-E41D-4969-B093-4B6B16028463}",
  nightly: "{849DCD04-E8E2-4D76-95D9-65B8B389D51D}",
  preview: "{18C7B91B-69F3-4D87-A932-0A7D2F871D5E}",
};
export const WINDOWS_PREVIEW_APP_ID = "{6D2B5079-2F0B-48DD-AB7F-97CEC514D30B}";
export const WINDOWS_PREVIEW_DLL = "ScientConversationPreview.dll";
export const MAC_PREVIEW_BUNDLE = "ScientConversationQuickLook.appex";

/** Carry the installed port notices and the fetched libarchive source license with the DLL. */
export async function stageWindowsPreviewNotices(
  shareDirectory: string,
  archiveCopying: string,
  destination: string,
): Promise<void> {
  const notices = new Map<string, string>();
  for (const entry of await NodeFSP.readdir(shareDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "libarchive") {
      throw new Error("libarchive must come from the pinned CMake source, not vcpkg.");
    }
    const source = NodePath.join(shareDirectory, entry.name, "copyright");
    const stat = await NodeFSP.lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    notices.set(`${entry.name}.txt`, source);
  }
  if (!notices.has("json-c.txt") || !notices.has("zlib.txt")) {
    throw new Error("Missing json-c or zlib license notice in the isolated vcpkg install.");
  }
  if (!(await NodeFSP.lstat(archiveCopying).catch(() => null))?.isFile())
    throw new Error("Missing libarchive COPYING from the pinned CMake source.");
  notices.set("libarchive.txt", archiveCopying);
  await NodeFSP.mkdir(destination, { recursive: true });
  for (const [name, source] of notices)
    await NodeFSP.copyFile(source, NodePath.join(destination, name));
}
export const MAC_PREVIEW_DEPENDENCIES = "json-c@0.19/libarchive@3.8.7/policy1";
export const WINDOWS_VCPKG_REVISION = "9e593bb18ea69cc5095e012465dcd675a822ed0d";
export const WINDOWS_PREVIEW_DEPENDENCIES = `libarchive@3.8.7/policy1/vcpkg@${WINDOWS_VCPKG_REVISION}`;

export function windowsPreviewInstalledRoot(buildDir: string): string {
  return NodePath.join(buildDir, "vcpkg-installed");
}

export function macPreviewVariant(arch: ConversationPreviewArch): "arm64" | "x86_64" | "universal" {
  return arch === "x64" ? "x86_64" : arch;
}

export function macPreviewArchitectures(arch: ConversationPreviewArch): ReadonlyArray<string> {
  return arch === "universal" ? ["arm64", "x86_64"] : [macPreviewVariant(arch)];
}

export function macPreviewBundleIdentifier(
  parentAppId: string,
  channel: ConversationPreviewChannel,
): string {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(parentAppId)) {
    throw new Error(`Invalid parent macOS app identifier: ${parentAppId}`);
  }
  return `${parentAppId}.${channel === "latest" ? "conversation-preview" : `${channel}.conversation-preview`}`;
}

/** Hash exact source, build recipes, and CI-pinned dependency inputs. */
export async function previewSourceSha256(repoRoot: string): Promise<string> {
  const files = [
    "scripts/build-conversation-preview.sh",
    "scripts/build-conversation-preview.ps1",
    "scripts/build-desktop-artifact.ts",
    "scripts/sign-macos.ts",
    "scripts/lib/conversation-preview-build.ts",
    "apps/desktop/scripts/conversation-file-type.mjs",
    ".github/workflows/conversation-preview.yml",
  ];
  const visit = async (relativeDir: string): Promise<void> => {
    const entries = await NodeFSP.readdir(NodePath.join(repoRoot, relativeDir), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Unsupported native preview source entry: ${relative}`);
    }
  };
  await visit("native/conversation-preview");
  const digest = NodeCrypto.createHash("sha256");
  for (const relative of files.sort()) {
    const bytes = await NodeFSP.readFile(NodePath.join(repoRoot, relative));
    digest
      .update(relative)
      .update("\0")
      .update(String(bytes.byteLength))
      .update("\0")
      .update(bytes);
  }
  return digest.digest("hex");
}

function previewDependencyRevision(platform: "mac" | "win"): string {
  if (platform === "mac") return MAC_PREVIEW_DEPENDENCIES;
  const root = process.env.VCPKG_ROOT;
  if (!root) throw new Error("VCPKG_ROOT is required for qualified Windows preview packaging.");
  const revision = NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const checkoutRoot = NodeChildProcess.execFileSync(
    "git",
    ["-C", root, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  const dirty = NodeChildProcess.execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  ).trim();
  const untrackedInputs = NodeChildProcess.execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--others",
      "--",
      "ports",
      "triplets",
      "scripts",
      "versions",
      "vcpkg-configuration.json",
    ],
    { encoding: "utf8" },
  ).trim();
  if (
    NodePath.resolve(checkoutRoot).toLowerCase() !== NodePath.resolve(root).toLowerCase() ||
    dirty ||
    untrackedInputs ||
    revision !== WINDOWS_VCPKG_REVISION
  ) {
    throw new Error(
      "The Windows preview vcpkg checkout is not a clean checkout at the CI-pinned revision.",
    );
  }
  return WINDOWS_PREVIEW_DEPENDENCIES;
}

/** A release gate, not evidence by itself: CI must issue qualified only after native QA. */
export function parsePreviewQualification(
  json: string,
  expected: {
    platform: "mac" | "win";
    arch: ConversationPreviewArch;
    channel: ConversationPreviewChannel;
    sourceSha256: string;
    dependencyRevision: string;
  },
): "qualified" | "candidate" {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object")
    throw new Error("Invalid native preview qualification manifest.");
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 2 ||
    (manifest.status !== "qualified" &&
      !(manifest.status === "candidate" && expected.channel === "preview")) ||
    manifest.platform !== expected.platform ||
    manifest.arch !== expected.arch ||
    manifest.channel !== expected.channel ||
    manifest.sourceSha256 !== expected.sourceSha256 ||
    manifest.dependencyRevision !== expected.dependencyRevision ||
    typeof manifest.evidence !== "string" ||
    manifest.evidence.trim().length === 0
  ) {
    throw new Error(
      `Native preview qualification does not cover ${expected.platform}/${expected.arch}/${expected.channel}.`,
    );
  }
  return manifest.status as "qualified" | "candidate";
}

export async function requirePreviewQualification(input: {
  readonly platform: "mac" | "win";
  readonly arch: ConversationPreviewArch;
  readonly channel: ConversationPreviewChannel;
  readonly manifestPath: string | undefined;
  readonly repoRoot: string;
}): Promise<"qualified" | "candidate"> {
  if (!input.manifestPath)
    throw new Error(
      "SCIC_PREVIEW_QUALIFIED_STAGE_MANIFEST is required for native preview packaging.",
    );
  const [json, sourceSha256] = await Promise.all([
    NodeFSP.readFile(input.manifestPath, "utf8"),
    previewSourceSha256(input.repoRoot),
  ]);
  return parsePreviewQualification(json, {
    ...input,
    sourceSha256,
    dependencyRevision: previewDependencyRevision(input.platform),
  });
}

export function previewBuildCommand(input: {
  readonly repoRoot: string;
  readonly buildDir: string;
  readonly platform: "mac" | "win";
  readonly arch: ConversationPreviewArch;
  readonly channel: ConversationPreviewChannel;
  readonly hostPlatform: NodeJS.Platform;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...process.env, SCIC_PREVIEW_CLSID: WINDOWS_PREVIEW_CLSIDS[input.channel] };
  if (input.platform === "mac") {
    if (input.hostPlatform !== "darwin")
      throw new Error("macOS conversation previews require a macOS build host.");
    return {
      command: "bash",
      args: [NodePath.join(input.repoRoot, "scripts/build-conversation-preview.sh")],
      env: {
        ...env,
        SCIC_PREVIEW_BUILD_DIR: input.buildDir,
        SCIC_PREVIEW_MAC_ARCH: macPreviewVariant(input.arch),
        SCIC_PREVIEW_MACOS_MIN: "12.0",
      },
    };
  }
  if (input.arch === "universal") {
    throw new Error("Windows conversation previews require an arm64 or x64 architecture.");
  }
  if (input.hostPlatform !== "win32")
    throw new Error("Windows conversation previews require a Windows build host.");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(input.repoRoot, "scripts/build-conversation-preview.ps1"),
      "-Triplet",
      input.arch === "arm64" ? "arm64-windows-static" : "x64-windows-static",
      "-BuildDirectory",
      input.buildDir,
    ],
    env,
  };
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd,
      env,
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

export function peMachine(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = view.getUint32(0x3c, true);
  if (header + 6 > bytes.byteLength || view.getUint32(header, true) !== 0x00004550)
    return undefined;
  return view.getUint16(header + 4, true);
}

export function clsidBinaryBytes(clsid: string): Uint8Array {
  const match =
    /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/iu.exec(clsid);
  if (!match) throw new Error(`Invalid preview CLSID: ${clsid}`);
  const hex = `${match[1]?.match(/../gu)?.toReversed().join("")}${match[2]?.match(/../gu)?.toReversed().join("")}${match[3]?.match(/../gu)?.toReversed().join("")}${match[4]}${match[5]}`;
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

export async function buildConversationPreview(input: {
  readonly repoRoot: string;
  readonly stageRoot: string;
  readonly platform: "mac" | "win";
  readonly arch: ConversationPreviewArch;
  readonly channel: ConversationPreviewChannel;
  readonly hostPlatform: NodeJS.Platform;
  readonly parentAppId: string;
}): Promise<string> {
  await NodeFSP.mkdir(input.stageRoot, { recursive: true });
  const buildDir = await NodeFSP.mkdtemp(
    NodePath.join(input.stageRoot, "conversation-preview-build-"),
  );
  const command = previewBuildCommand({ ...input, buildDir });
  await NodeFSP.mkdir(buildDir, { recursive: true });
  await run(command.command, command.args, input.repoRoot, command.env);
  if (input.platform === "mac") {
    const bundle = NodePath.join(
      buildDir,
      `macos-${macPreviewVariant(input.arch)}`,
      "xcode/Release",
      MAC_PREVIEW_BUNDLE,
    );
    const executable = NodePath.join(bundle, "Contents/MacOS/ScientConversationQuickLook");
    const infoPlist = NodePath.join(bundle, "Contents/Info.plist");
    if (!(await NodeFSP.stat(bundle)).isDirectory())
      throw new Error(`Missing Quick Look extension: ${bundle}`);
    await NodeFSP.access(executable);
    const archs = NodeChildProcess.execFileSync("lipo", ["-archs", executable], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/u);
    const expected = macPreviewArchitectures(input.arch);
    if (archs.length !== expected.length || !expected.every((arch) => archs.includes(arch))) {
      throw new Error(
        `Quick Look extension architecture ${archs.join(", ")} does not match ${expected.join(", ")}.`,
      );
    }
    const bundleId = macPreviewBundleIdentifier(input.parentAppId, input.channel);
    NodeChildProcess.execFileSync("plutil", [
      "-replace",
      "CFBundleIdentifier",
      "-string",
      bundleId,
      infoPlist,
    ]);
    const actualBundleId = NodeChildProcess.execFileSync(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
      { encoding: "utf8" },
    ).trim();
    if (actualBundleId !== bundleId) {
      throw new Error(
        `Quick Look extension bundle ID ${actualBundleId} does not match ${bundleId}.`,
      );
    }
    return bundle;
  }
  const candidates = [
    NodePath.join(buildDir, "Release", WINDOWS_PREVIEW_DLL),
    NodePath.join(buildDir, WINDOWS_PREVIEW_DLL),
  ];
  const dll = (
    await Promise.all(
      candidates.map(async (candidate) =>
        (await NodeFSP.stat(candidate).catch(() => null))?.isFile() ? candidate : null,
      ),
    )
  ).find(Boolean);
  if (!dll) throw new Error(`Native preview build did not produce ${WINDOWS_PREVIEW_DLL}.`);
  const bytes = await NodeFSP.readFile(dll);
  const expectedMachine = input.arch === "arm64" ? 0xaa64 : 0x8664;
  if (peMachine(bytes) !== expectedMachine)
    throw new Error(`Preview DLL machine does not match ${input.arch}.`);
  if (!includesBytes(bytes, clsidBinaryBytes(WINDOWS_PREVIEW_CLSIDS[input.channel]))) {
    throw new Error(
      `Preview DLL does not contain the ${input.channel} channel CLSID; native build must honor SCIC_PREVIEW_CLSID.`,
    );
  }
  await stageWindowsPreviewNotices(
    NodePath.join(windowsPreviewInstalledRoot(buildDir), `${input.arch}-windows-static`, "share"),
    NodePath.join(buildDir, "_deps", "scic_libarchive-src", "COPYING"),
    `${dll}.licenses`,
  );
  return dll;
}
