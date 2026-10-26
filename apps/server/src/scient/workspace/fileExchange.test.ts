// @effect-diagnostics nodeBuiltinImport:off -- Real helper binary on real disk images.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";

import { bindNativeFilePublication, runNativeFilePublication } from "./NativeFilePublication.ts";

const publication = await filePublicationTestHelper();
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

describe.skipIf(publication === undefined || !diskImages)("file publication on other disks", () => {
  it.each(["APFS", "MS-DOS FAT32", "ExFAT", "JHFS+"])(
    "preserves both files on %s, exchanging only when supported",
    (format) =>
      onDisk(format, async (folder) => {
        const rootPath = await NodeFSP.realpath(folder);
        const recordPath = NodePath.join(rootPath, "record");
        await NodeFSP.mkdir(recordPath, { mode: 0o700 });
        const target = NodePath.join(rootPath, "target");
        const staged = NodePath.join(recordPath, "staged");
        await NodeFSP.writeFile(target, "original");
        await NodeFSP.writeFile(staged, "replacement");
        const binding = await bindNativeFilePublication(
          publication!,
          {
            rootPath,
            parentRelativePath: ".",
            recordPath,
          },
          "bound-object",
        );
        const result = await runNativeFilePublication(publication!, {
          binding,
          operation: "exchange",
          authority: "bound-object",
          sourceName: "staged",
          destinationName: "target",
        });
        if (format === "APFS") {
          expect(result.code).toBe(0);
          expect(result.outcome).toBe("applied");
          expect(await NodeFSP.readFile(target, "utf8")).toBe("replacement");
          expect(await NodeFSP.readFile(staged, "utf8")).toBe("original");
        } else {
          expect(result.code).not.toBe(0);
          expect(result.outcome).toBe("unchanged");
          expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
          expect(await NodeFSP.readFile(staged, "utf8")).toBe("replacement");
        }
      }),
  );
});
