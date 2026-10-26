// @effect-diagnostics nodeBuiltinImport:off -- Compile and inspect real native staging fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";
import { validatePackagedFilePublication } from "./scient-file-publication-build.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")("publication packaging", () => {
  it("refuses to substitute a macOS helper for a Linux artifact", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cross-platform-"));
    try {
      expect(() =>
        NodeChildProcess.execFileSync(
          process.execPath,
          [
            NodePath.join(repoRoot, "scripts/stage-file-exchange.ts"),
            "--platform=linux",
            `--destination=${root}`,
          ],
          { stdio: "pipe" },
        ),
      ).toThrow("target OS");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["x64", "universal"] as const)(
    "stages and validates the exact %s slices",
    async (arch) => {
      const root = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "scient-publication-stage-"),
      );
      try {
        const app = NodePath.join(root, "Scient.app");
        const resources = NodePath.join(app, "Contents/Resources/file-exchange");
        await NodeFSP.mkdir(resources, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(resources, "scient-file-exchange"),
          "obsolete helper",
        );
        await NodeFSP.writeFile(NodePath.join(resources, "provenance.json"), "obsolete receipt");
        NodeChildProcess.execFileSync(process.execPath, [
          NodePath.join(repoRoot, "scripts/stage-file-exchange.ts"),
          `--arch=${arch}`,
          `--destination=${resources}`,
        ]);
        expect(await NodeFSP.readdir(resources)).toEqual([
          "publication-artifact.json",
          "scient-file-publication",
        ]);
        await validatePackagedFilePublication(app, arch);
        const receiptPath = NodePath.join(resources, "publication-artifact.json");
        const receipt = await NodeFSP.readFile(receiptPath, "utf8");
        await NodeFSP.writeFile(
          receiptPath,
          JSON.stringify({ ...JSON.parse(receipt), probe: true }),
        );
        await expect(validatePackagedFilePublication(app, arch)).rejects.toThrow();
        await NodeFSP.writeFile(receiptPath, receipt);
        await expect(validatePackagedFilePublication(app, "arm64")).rejects.toThrow(
          "wrong architecture",
        );
        await NodeFSP.unlink(NodePath.join(resources, "scient-file-publication"));
        await expect(validatePackagedFilePublication(app, arch)).rejects.toThrow();
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
