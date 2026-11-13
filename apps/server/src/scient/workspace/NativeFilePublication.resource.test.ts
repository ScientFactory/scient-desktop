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
  windowsPermissionsRefusal,
  windowsPermissionTargets,
  windowsUserSid,
} from "@t3tools/shared/scientPublicationArtifact";
import { expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import {
  acceptedNativeFilePublicationHelper,
  closeNativeHelperServers,
  invokeNativeHelper,
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

it("checks an accepted helper again once it cannot be launched", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-gone-")),
  );
  const helper = await stageHelper(NodePath.join(root, "install"));
  try {
    expect(await nativeFilePublicationHelper(helper)).toBe(helper);
    await NodeFSP.rm(helper);
    await expect(invokeNativeHelper(helper, ["--protocol=1", "capabilities"])).rejects.toThrow();
    expect(acceptedNativeFilePublicationHelper(helper)).toBeUndefined();
    expect(await nativeFilePublicationHelper(helper)).toBeUndefined();
  } finally {
    await closeNativeHelperServers();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

/** Runs the permission script for `paths` with PowerShell in `languageMode`. */
const descriptors = (paths: ReadonlyArray<string>, languageMode: string) =>
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
        // Invoke-Expression compiles the check in the session's language mode, as a locked-down
        // host (AppLocker, WDAC) compiles an encoded command. Such a host trusts Windows' signed
        // modules; a mode set in-session can't load them, so Get-Acl's is loaded first.
        Buffer.from(
          `Import-Module Microsoft.PowerShell.Security
$ExecutionContext.SessionState.LanguageMode = '${languageMode}'
"mode: $($ExecutionContext.SessionState.LanguageMode)"
Invoke-Expression $env:SCIENT_PERMISSIONS_SCRIPT`,
          "utf16le",
        ).toString("base64"),
      ],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
          ),
          SCIENT_PUBLICATION_ACL_PATHS: paths.join("\n"),
          SCIENT_PERMISSIONS_SCRIPT: WINDOWS_PERMISSIONS_SCRIPT,
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${error.message}\n${stderr}`));
        const [mode, ...rest] = stdout.split(/\r?\n/u);
        if (mode?.trim() !== `mode: ${languageMode}`) return reject(new Error(stdout));
        resolve(rest.join("\n"));
      },
    ),
  );

it.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "Windows' permission check gives the same answer in Constrained Language Mode",
  async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-constrained-")),
    );
    try {
      const helper = await stageHelper(NodePath.join(root, "install"));
      const user = await windowsUserSid();
      const targets = windowsPermissionTargets(helper);
      const verdicts = async () =>
        Promise.all(
          ["FullLanguage", "ConstrainedLanguage"].map(async (mode) =>
            windowsPermissionsRefusal(
              targets,
              await descriptors(
                targets.map(({ path }) => path),
                mode,
              ),
              user,
            ),
          ),
        );
      expect(await verdicts()).toEqual([undefined, undefined]);
      expect(await validatePublicationArtifact(helper)).toBe(helper);
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      for (const mode of ["FullLanguage", "ConstrainedLanguage"])
        expect(
          windowsPermissionsRefusal(
            [{ path: programFiles, mask: 0xd0040 }],
            await descriptors([programFiles], mode),
            user,
          ),
        ).toBeUndefined();
      NodeChildProcess.execFileSync("icacls", [
        NodePath.dirname(helper),
        "/grant",
        "*S-1-1-0:(OI)(CI)M",
      ]);
      const [full, constrained] = await verdicts();
      expect(full).toMatch(/writable by another principal/u);
      expect(constrained).toBe(full);
      await expect(validatePublicationArtifact(helper)).rejects.toThrow(
        /writable by another principal/u,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
