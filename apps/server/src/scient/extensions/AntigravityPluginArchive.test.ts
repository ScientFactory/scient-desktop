import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  checkStagedManifest,
  extractAntigravityArchive,
  isAntigravityPluginArchiveError,
} from "./AntigravityPluginArchive.ts";
import { makeZip, renameInZip } from "./AntigravityPluginArchive.testkit.ts";

const extract = (zip: Buffer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const archive = path.join(root, "plugin.zip");
    const target = path.join(root, "plugin");
    yield* fs.writeFile(archive, zip);
    yield* fs.makeDirectory(target);
    const result = yield* extractAntigravityArchive(archive, target).pipe(Effect.result);
    return { result, target, fs, path };
  });

const refusal = (zip: Effect.Effect<Buffer>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { result, target, fs } = yield* extract(yield* zip);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(isAntigravityPluginArchiveError(result.failure)).toBe(true);
        expect(result.failure.reason).toBe("unsafe-archive");
      }
      return yield* fs.readDirectory(target, { recursive: true });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("extractAntigravityArchive", () => {
  it.effect("unpacks plain files and keeps executable bits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, target, fs, path } = yield* extract(
          yield* makeZip([
            { name: "plugin.json", data: '{"name":"gmail"}' },
            { name: "skills/", directory: true },
            { name: "skills/gmail/scripts/gmail", data: "#!/bin/sh", mode: 0o100755 },
          ]),
        );
        expect(result._tag).toBe("Success");
        const script = yield* fs.stat(path.join(target, "skills", "gmail", "scripts", "gmail"));
        expect(Number(script.mode) & 0o111).not.toBe(0);
        const manifest = yield* fs.stat(path.join(target, "plugin.json"));
        expect(Number(manifest.mode) & 0o111).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses links", () =>
    Effect.gen(function* () {
      const written = yield* refusal(
        makeZip([
          { name: "a.txt", data: "a" },
          { name: "link", data: "/etc/passwd", mode: 0o120777 },
        ]),
      );
      expect(written).not.toContain("link");
    }),
  );

  it.effect("refuses special files", () =>
    refusal(makeZip([{ name: "pipe", mode: 0o010644 }])).pipe(Effect.asVoid),
  );

  it.effect("refuses names that leave the folder", () =>
    refusal(
      makeZip([{ name: "zz/evil.txt", data: "x" }]).pipe(
        Effect.map((zip) => renameInZip(zip, "zz/evil.txt", "../evil.txt")),
      ),
    ).pipe(Effect.asVoid),
  );

  it.effect("refuses two members that land on one name", () =>
    refusal(
      makeZip([
        { name: "Skill.md", data: "one" },
        { name: "skill.md", data: "two" },
      ]),
    ).pipe(Effect.asVoid),
  );

  it.effect("refuses an archive larger than its unpacked limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const archive = path.join(root, "plugin.zip");
        yield* fs.writeFile(
          archive,
          yield* makeZip([
            { name: "a", data: "x".repeat(600) },
            { name: "b", data: "x".repeat(600) },
          ]),
        );
        yield* fs.makeDirectory(path.join(root, "plugin"));
        const result = yield* extractAntigravityArchive(archive, path.join(root, "plugin"), {
          unpackedBytes: 1_000,
        }).pipe(Effect.flip);
        expect(result.reason).toBe("unsafe-archive");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("checkStagedManifest", () => {
  it.effect("requires the catalog's name and version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          path.join(root, "plugin.json"),
          '{"name":"gmail","version":"0.0.7"}',
        );
        yield* checkStagedManifest(root, { name: "gmail", version: "0.0.7" });
        yield* checkStagedManifest(root, { name: "gmail" });
        const wrongName = yield* checkStagedManifest(root, { name: "gdrive" }).pipe(Effect.flip);
        expect(wrongName.reason).toBe("manifest");
        const wrongVersion = yield* checkStagedManifest(root, {
          name: "gmail",
          version: "0.0.8",
        }).pipe(Effect.flip);
        expect(wrongVersion.reason).toBe("manifest");
        yield* fs.remove(path.join(root, "plugin.json"));
        expect((yield* checkStagedManifest(root, { name: "gmail" }).pipe(Effect.flip)).reason).toBe(
          "manifest",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
