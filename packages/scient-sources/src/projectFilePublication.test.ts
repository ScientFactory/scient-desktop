// @effect-diagnostics nodeBuiltinImport:off -- Publication is tested against a real folder with an injected link failure.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  publishScientProjectFile,
  ScientProjectFilePublicationError,
} from "./projectFilePublication.ts";

const isPublicationError = Schema.is(ScientProjectFilePublicationError);

describe("publishScientProjectFile", () => {
  it("keeps the original or a concurrent edit when publishing fails after moving it aside", async () => {
    const expected = "Original manuscript — [@old]\n";
    // The mutable module object behind the namespace, so the helper sees the injected link.
    const fsPromises: { link: typeof NodeFSP.link } = NodeModule.createRequire(import.meta.url)(
      "node:fs/promises",
    );
    const originalLink = fsPromises.link;
    for (const onDisk of [expected, "Concurrent user edit — keep me\n"]) {
      for (const failures of [1, Infinity]) {
        const directory = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "scient-publication-"),
        );
        const target = NodePath.join(directory, "manuscript.md");
        let remaining = failures;
        try {
          await NodeFSP.writeFile(target, onDisk);
          fsPromises.link = async (source, destination) => {
            if (destination === target && remaining-- > 0) {
              throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
            }
            return originalLink(source, destination);
          };
          NodeModule.syncBuiltinESMExports();

          const error = await publishScientProjectFile({
            filePath: target,
            expected,
            contents: "Original manuscript — [@new]\n",
          }).then(
            () => null,
            (cause: unknown) => cause,
          );

          expect(error).toBeInstanceOf(Error);
          const survivor = isPublicationError(error) ? error.recoveryPath : target;
          expect(failures === Infinity).toBe(survivor !== target);
          expect(await NodeFSP.readFile(survivor, "utf8")).toBe(onDisk);
          expect(await NodeFSP.readdir(directory)).toEqual([NodePath.basename(survivor)]);
        } finally {
          fsPromises.link = originalLink;
          NodeModule.syncBuiltinESMExports();
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
});
