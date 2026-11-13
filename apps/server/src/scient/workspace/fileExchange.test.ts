// @effect-diagnostics nodeBuiltinImport:off -- Real helper binary on real disk images.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { createDiskImage, diskImagesAvailable, type DiskImageFormat } from "./diskImage.testkit.ts";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";

import { bindNativeFilePublication, runNativeFilePublication } from "./NativeFilePublication.ts";

const publication = await filePublicationTestHelper();
/** Mounts a fresh disk image of `format`, runs `body` in a folder on it, then detaches. */
async function onDisk(format: DiskImageFormat, body: (folder: string) => Promise<void>) {
  const image = await createDiskImage(format, { volumeName: "SCTSWAP" });
  try {
    const folder = NodePath.join(await image.attach(), "paper");
    await NodeFSP.mkdir(folder);
    await body(folder);
  } finally {
    await image.dispose();
  }
}

describe.skipIf(publication === undefined || !diskImagesAvailable)(
  "file publication on other disks",
  () => {
    it.each<DiskImageFormat>(["APFS", "MS-DOS FAT32", "ExFAT", "JHFS+"])(
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
  },
);
