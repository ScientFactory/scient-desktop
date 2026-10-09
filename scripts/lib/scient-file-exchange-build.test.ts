// @effect-diagnostics nodeBuiltinImport:off -- Compile and inspect real native staging fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "vite-plus/test";
import {
  buildFileExchange,
  stageFileExchangeForDesktopBuild,
  validatePackagedFileExchange,
} from "./scient-file-exchange-build.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
describe.skipIf(HostProcessPlatform.defaultValue() !== "darwin")("file exchange packaging", () => {
  it.each(["arm64", "x64", "universal"] as const)("stages the exact %s slices", async (arch) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-exchange-stage-"));
    try {
      await stageFileExchangeForDesktopBuild({
        repoRoot,
        stageResourcesDir: root,
        platform: "mac",
        arch,
      });
      const helper = NodePath.join(root, "file-exchange/scient-file-exchange");
      const actual = NodeChildProcess.execFileSync("lipo", ["-archs", helper], { encoding: "utf8" })
        .trim()
        .split(/\s+/u)
        .sort();
      expect(actual).toEqual(
        (arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : "arm64"]).sort(),
      );
      if (arch === "arm64" || arch === "universal")
        expect(
          NodeChildProcess.execFileSync(helper, ["--version"], { encoding: "utf8" }).trim(),
        ).toBe("scient-file-exchange/1");
      expect((await NodeFSP.stat(helper)).mode & 0o111).toBe(0o111);
      const app = NodePath.join(root, "Scient.app");
      const resources = NodePath.join(app, "Contents/Resources");
      await NodeFSP.mkdir(resources, { recursive: true });
      await NodeFSP.cp(
        NodePath.join(root, "file-exchange"),
        NodePath.join(resources, "file-exchange"),
        { recursive: true },
      );
      await validatePackagedFileExchange(app, arch);
      await expect(
        validatePackagedFileExchange(app, arch === "arm64" ? "x64" : "arm64"),
      ).rejects.toThrow("wrong architecture");
      await NodeFSP.unlink(NodePath.join(resources, "file-exchange/scient-file-exchange"));
      await expect(validatePackagedFileExchange(app, arch)).rejects.toThrow();
      await stageFileExchangeForDesktopBuild({
        repoRoot,
        stageResourcesDir: root,
        platform: "win",
        arch,
      });
      expect(
        await NodeFSP.access(helper).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("does not pretend to cross-compile Linux on macOS", async () => {
    await expect(
      buildFileExchange({ repoRoot, outputDirectory: "/unused", platform: "linux", arch: "x64" }),
    ).rejects.toThrow("target operating system");
  });
});
