// @effect-diagnostics nodeBuiltinImport:off -- Real staged native resource and receipt negative controls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  publicationDigest,
  validatePublicationArtifact,
  WINDOWS_PERMISSIONS_SCRIPT,
} from "@t3tools/shared/scientPublicationArtifact";
import { expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import {
  acceptedNativeFilePublicationHelper,
  nativeFilePublicationHelper,
  resolveNativeFilePublicationHelperPath,
} from "./NativeFilePublication.ts";

const binary =
  HostProcess.Platform.defaultValue() === "win32"
    ? "scient-file-publication.exe"
    : "scient-file-publication";

/** A copy of the built helper and its receipt in `directory`, as an install places them. */
async function stageHelper(directory: string) {
  const staged = (await filePublicationTestHelper())!;
  await NodeFSP.mkdir(directory, { recursive: true });
  const helper = NodePath.join(directory, binary);
  await NodeFSP.copyFile(staged, helper);
  await NodeFSP.chmod(helper, 0o755);
  await NodeFSP.copyFile(
    NodePath.join(NodePath.dirname(staged), "publication-artifact.json"),
    NodePath.join(directory, "publication-artifact.json"),
  );
  return helper;
}

it("admits only an executable host artifact with an intact production receipt and protocol", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-resource-")),
  );
  const platform = HostProcess.Platform.defaultValue();
  const binary = platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication";
  const helper = NodePath.join(root, binary);
  const receiptPath = NodePath.join(root, "publication-artifact.json");
  try {
    if (platform === "win32") {
      const staged = await filePublicationTestHelper();
      await NodeFSP.copyFile(staged!, helper);
      await NodeFSP.copyFile(
        NodePath.join(NodePath.dirname(staged!), "publication-artifact.json"),
        receiptPath,
      );
    } else {
      NodeChildProcess.execFileSync(process.execPath, [
        NodePath.resolve(import.meta.dirname, "../../../../../scripts/stage-file-exchange.ts"),
        `--destination=${root}`,
      ]);
    }
    await validatePublicationArtifact(helper);
    expect(await resolveNativeFilePublicationHelperPath(helper)).toBe(helper);
    const bytes = await NodeFSP.readFile(helper);
    const receipt = JSON.parse(await NodeFSP.readFile(receiptPath, "utf8"));
    for (const changed of [
      { ...receipt, arch: "wrong-arch" },
      { ...receipt, probe: true },
      { ...receipt, sha256: "0".repeat(64) },
    ]) {
      await NodeFSP.writeFile(receiptPath, JSON.stringify(changed));
      expect(await resolveNativeFilePublicationHelperPath(helper)).toBeUndefined();
    }
    const wrong = Buffer.from(bytes);
    wrong.fill(0, 0, 16);
    await NodeFSP.writeFile(helper, wrong);
    await NodeFSP.writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, sha256: publicationDigest(wrong) }),
    );
    expect(await resolveNativeFilePublicationHelperPath(helper)).toBeUndefined();
    await NodeFSP.writeFile(helper, bytes);
    await NodeFSP.writeFile(receiptPath, JSON.stringify(receipt));
    if (platform !== "win32") {
      await NodeFSP.chmod(helper, 0o644);
      expect(await resolveNativeFilePublicationHelperPath(helper)).toBeUndefined();
      await NodeFSP.chmod(helper, 0o755);
      await NodeFSP.rename(helper, `${helper}.real`);
      await NodeFSP.symlink(`${helper}.real`, helper);
      expect(await resolveNativeFilePublicationHelperPath(helper)).toBeUndefined();
      await NodeFSP.unlink(helper);
      await NodeFSP.rename(`${helper}.real`, helper);
    }
    await NodeFSP.unlink(receiptPath);
    expect(await resolveNativeFilePublicationHelperPath(helper)).toBeUndefined();
    expect(
      await resolveNativeFilePublicationHelperPath(NodePath.join(root, "missing", binary)),
    ).toBeUndefined();
    expect(await resolveNativeFilePublicationHelperPath(binary)).toBeUndefined();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("accepts a helper that passes after a refusal, and keeps the pass", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-late-")),
  );
  const helper = NodePath.join(root, "install", binary);
  try {
    expect(await nativeFilePublicationHelper(helper)).toBeUndefined();
    expect(acceptedNativeFilePublicationHelper(helper)).toBeUndefined();
    await stageHelper(NodePath.dirname(helper));
    expect(await nativeFilePublicationHelper(helper)).toBe(helper);
    expect(acceptedNativeFilePublicationHelper(helper)).toBe(helper);
    await NodeFSP.writeFile(NodePath.join(root, "install", "publication-artifact.json"), "{}");
    expect(await nativeFilePublicationHelper(helper)).toBe(helper);
    expect(await nativeFilePublicationHelper(helper, { revalidate: true })).toBeUndefined();
    expect(acceptedNativeFilePublicationHelper(helper)).toBeUndefined();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

// Locked-down Windows (AppLocker, WDAC) runs PowerShell in Constrained Language Mode, which
// refuses the check's .NET calls; that is why a helper installed with the server skips it.
it.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "Windows' permission check cannot run in Constrained Language Mode",
  async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-constrained-")),
    );
    try {
      const helper = await stageHelper(root);
      // Invoke-Expression compiles the check in the session's language mode, as a locked-down
      // host compiles an encoded command.
      const check = (languageMode: string) =>
        new Promise<string>((resolve, reject) =>
          NodeChildProcess.execFile(
            NodePath.join(
              process.env.SystemRoot ?? "C:/Windows",
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(
                `$ExecutionContext.SessionState.LanguageMode = '${languageMode}'
try { Invoke-Expression $env:SCIENT_PERMISSIONS_SCRIPT; 'passed' } catch { "refused: $($_.Exception.Message)" }`,
                "utf16le",
              ).toString("base64"),
            ],
            {
              env: {
                ...process.env,
                SCIENT_PUBLICATION_VALIDATE: helper,
                SCIENT_PERMISSIONS_SCRIPT: WINDOWS_PERMISSIONS_SCRIPT,
              },
              windowsHide: true,
            },
            (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
          ),
        );
      expect(await check("FullLanguage")).toBe("passed");
      expect(await check("ConstrainedLanguage")).toMatch(/^refused: .*language mode/iu);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
