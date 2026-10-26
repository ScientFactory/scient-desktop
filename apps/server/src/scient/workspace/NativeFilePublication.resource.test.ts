// @effect-diagnostics nodeBuiltinImport:off -- Real staged native resource and receipt negative controls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { publicationDigest } from "@t3tools/shared/scientPublicationArtifact";
import { expect, it } from "@effect/vitest";
import { resolveNativeFilePublicationHelperPath } from "./NativeFilePublication.ts";

it("admits only an executable host artifact with an intact production receipt and protocol", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-helper-resource-")),
  );
  const platform = HostProcess.Platform.defaultValue();
  const binary = platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication";
  const helper = NodePath.join(root, binary);
  const receiptPath = NodePath.join(root, "publication-artifact.json");
  try {
    NodeChildProcess.execFileSync(process.execPath, [
      NodePath.resolve(import.meta.dirname, "../../../../../scripts/stage-file-exchange.ts"),
      `--destination=${root}`,
    ]);
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
