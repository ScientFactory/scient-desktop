import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copyDownloadToDirectory } from "./DownloadCopy.ts";

it.layer(NodeServices.layer)("download copies", (it) => {
  it.effect("keeps every concurrent same-name download in a distinct destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const downloads = path.join(root, "downloads");
      yield* fs.makeDirectory(downloads);
      const sources = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          fs
            .writeFileString(path.join(root, `source-${index}`), `download ${index}`)
            .pipe(Effect.as(path.join(root, `source-${index}`))),
      );
      const destinations = yield* Effect.forEach(
        sources,
        (source) => copyDownloadToDirectory(source, "report.csv", downloads),
        { concurrency: "unbounded" },
      );

      expect(new Set(destinations).size).toBe(sources.length);
      expect(destinations).toContain(path.join(downloads, "report.csv"));
      for (const [index, destination] of destinations.entries()) {
        expect(yield* fs.readFileString(destination)).toBe(`download ${index}`);
        expect(yield* fs.readFileString(sources[index]!)).toBe(`download ${index}`);
      }
      expect(yield* fs.readDirectory(downloads)).toHaveLength(sources.length);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves existing files and broken symlinks belonging to external writers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const downloads = path.join(root, "downloads");
      yield* fs.makeDirectory(downloads);
      const source = path.join(root, "source");
      yield* fs.writeFileString(source, "new download");
      yield* fs.writeFileString(path.join(downloads, "report.csv"), "external writer");
      const missing = path.join(root, "external-missing");
      yield* fs.symlink(missing, path.join(downloads, "report (1).csv"));

      const destination = yield* copyDownloadToDirectory(source, "../report.csv", downloads);
      expect(destination).toBe(path.join(downloads, "report (2).csv"));
      expect(yield* fs.readFileString(destination)).toBe("new download");
      expect(yield* fs.readFileString(path.join(downloads, "report.csv"))).toBe("external writer");
      expect(yield* fs.readLink(path.join(downloads, "report (1).csv"))).toBe(missing);
      expect(yield* fs.exists(missing)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a source failure without creating or overwriting a destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const downloads = path.join(root, "downloads");
      yield* fs.makeDirectory(downloads);
      const source = path.join(root, "missing");

      const error = yield* Effect.flip(copyDownloadToDirectory(source, "report.csv", downloads));
      expect(error).toMatchObject({
        _tag: "PreviewDownloadCopyError",
        source,
        directory: downloads,
      });
      expect(yield* fs.readDirectory(downloads)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports the bounded name limit without replacing any existing file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const downloads = path.join(root, "downloads");
      yield* fs.makeDirectory(downloads);
      const source = path.join(root, "source");
      yield* fs.writeFileString(source, "new download");
      const names = Array.from({ length: 100 }, (_, index) =>
        index === 0 ? "report.csv" : `report (${index}).csv`,
      );
      yield* Effect.forEach(names, (name) =>
        fs.writeFileString(path.join(downloads, name), `owned ${name}`),
      );

      const error = yield* Effect.flip(copyDownloadToDirectory(source, "report.csv", downloads));
      expect(error.cause).toBeInstanceOf(Error);
      expect(yield* fs.readDirectory(downloads)).toHaveLength(100);
      for (const name of names) {
        expect(yield* fs.readFileString(path.join(downloads, name))).toBe(`owned ${name}`);
      }
    }).pipe(Effect.scoped),
  );
});
