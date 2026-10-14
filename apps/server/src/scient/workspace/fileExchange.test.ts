// @effect-diagnostics nodeBuiltinImport:off -- Real helper binary on real disk images.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { fileExchangeTestHelper } from "./fileExchange.testkit.ts";

const helper = await fileExchangeTestHelper();
const diskImages =
  HostProcess.Platform.defaultValue() === "darwin" &&
  NodeChildProcess.spawnSync("/usr/bin/hdiutil", ["help"]).status !== null;

/** Mounts a fresh disk image of `format`, runs `body` in a folder on it, then detaches. */
async function onDisk(format: string, body: (folder: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-exchange-disk-"));
  const image = NodePath.join(root, "disk.dmg"),
    mounted = NodePath.join(root, "mount");
  try {
    NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-size",
      "40m",
      "-fs",
      format,
      "-volname",
      "SCTSWAP",
      image,
    ]);
    await NodeFSP.mkdir(mounted);
    NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
      "attach",
      "-quiet",
      "-nobrowse",
      "-mountpoint",
      mounted,
      image,
    ]);
    try {
      const folder = NodePath.join(mounted, "paper");
      await NodeFSP.mkdir(folder);
      await body(folder);
    } finally {
      NodeChildProcess.execFileSync("/usr/bin/hdiutil", ["detach", "-force", "-quiet", mounted]);
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

const swap = (left: string, right: string) =>
  NodeChildProcess.spawnSync(helper!, [left, right], { encoding: "utf8" });

describe.skipIf(helper === undefined || !diskImages)("file exchange helper on other disks", () => {
  it("swaps on APFS", () =>
    onDisk("APFS", async (folder) => {
      const [left, right] = [NodePath.join(folder, "a"), NodePath.join(folder, "b")];
      await NodeFSP.writeFile(left, "first");
      await NodeFSP.writeFile(right, "second");
      expect(swap(left, right).status).toBe(0);
      expect(await NodeFSP.readFile(left, "utf8")).toBe("second");
      expect(await NodeFSP.readFile(right, "utf8")).toBe("first");
    }));

  // FAT32's driver answers a swap with a plain rename that destroys the second
  // file, and still reports success. The helper must refuse before calling it.
  it.each(["MS-DOS FAT32", "ExFAT", "JHFS+"])("refuses %s and leaves both files", (format) =>
    onDisk(format, async (folder) => {
      const [left, right] = [NodePath.join(folder, "a"), NodePath.join(folder, "b")];
      await NodeFSP.writeFile(left, "first");
      await NodeFSP.writeFile(right, "second");
      const result = swap(left, right);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("45");
      expect(await NodeFSP.readFile(left, "utf8")).toBe("first");
      expect(await NodeFSP.readFile(right, "utf8")).toBe("second");
    }),
  );
});
