// @effect-diagnostics nodeBuiltinImport:off -- Managed bibliography tests exercise real project files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { formatBibliography } from "@scientfactory/scient-sources/bibliography";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceRecord,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  SCIENT_SOURCES_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import { scientProjectFilePublicationHooks } from "@scientfactory/scient-sources/project-files";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { syncManagedBibliography } from "./ManagedBibliography.ts";
import {
  addSource,
  nodeError,
  overrideFileSystem,
  readProjectFile,
  sourceCandidate,
} from "./ManagedBibliography.testkit.ts";
import { syncManagedBibliographyWithImports } from "./ScientSourcesCoordinator.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bibliography-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  return root;
}

const add = addSource;
const read = readProjectFile;

describe("managed bibliography", () => {
  it("writes nothing for a project without a Library", async () => {
    const root = await project();
    const status = await syncManagedBibliography(root);
    expect(status.files.map((file) => file.state)).toEqual(["absent", "absent"]);
    await expect(NodeFSP.access(NodePath.join(root, "references.bib"))).rejects.toThrow();
  });

  it("writes both files from the Library and keeps them current", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");

    expect((await syncManagedBibliography(root)).files.map((file) => file.state)).toEqual([
      "current",
      "current",
    ]);
    expect(await read(root, "references.bib")).toContain("@article{lovelace1843notes,");
    expect(JSON.parse(await read(root, "references.json"))).toMatchObject([
      { id: "lovelace1843notes", type: "article-journal" },
    ]);

    await add(root, "B", "Sketch of the engine");
    const status = await syncManagedBibliography(root);
    expect(status.citedSourceCount).toBe(2);
    expect(await read(root, "references.bib")).toContain("@article{lovelace1843sketch,");
  });

  it("drops abstracts from files an earlier version wrote with them, without reporting an edit", async () => {
    const root = await project();
    await importScientSource({
      root,
      operationId: "abstract-upgrade",
      candidate: {
        ...sourceCandidate("A", "Notes on the analytical engine"),
        abstract: "Long abstract.",
      },
    });
    await syncManagedBibliography(root);
    const [source] = await listScientSourceRecords(root);
    const items = [{ record: source!, citationKey: source!.citationKey! }];
    for (const [name, format] of [
      ["references.bib", "bibtex"],
      ["references.json", "csl-json"],
    ] as const) {
      const earlier = (await read(root, name)).replace(
        formatBibliography(items, format, { includeNotes: false, includeAbstracts: false }),
        formatBibliography(items, format, { includeNotes: false }),
      );
      expect(earlier).toContain("Long abstract.");
      await NodeFSP.writeFile(NodePath.join(root, name), earlier);
      await NodeFSP.writeFile(
        NodePath.join(root, SCIENT_SOURCES_DIRECTORY, "bibliography", name),
        earlier,
      );
    }

    const status = await syncManagedBibliography(root);
    expect(status.files).toEqual([
      { name: "references.bib", state: "current", changes: null },
      { name: "references.json", state: "current", changes: null },
    ]);
    expect(await read(root, "references.bib")).not.toContain("Long abstract.");
    expect(await read(root, "references.json")).not.toContain("Long abstract.");
    expect((await NodeFSP.readdir(root)).filter((name) => name.includes(".kept-"))).toEqual([]);
  });

  it("keeps a hand edit, reports it, and replaces it only when asked", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");
    await syncManagedBibliography(root);
    const bibPath = NodePath.join(root, "references.bib");
    const edited = `${await read(root, "references.bib")}\n@misc{mine2020,\n  title = {Mine},\n}\n`;
    await NodeFSP.writeFile(bibPath, edited);
    await add(root, "B", "Sketch of the engine");

    const status = await syncManagedBibliography(root);
    expect(status.files[0]).toEqual({
      name: "references.bib",
      state: "edited",
      changes: { added: ["mine2020"], changed: [], removed: [] },
    });
    expect(status.files[1]?.state).toBe("current");
    expect(await read(root, "references.bib")).toBe(edited);

    await syncManagedBibliography(root, { replaceEdited: ["references.bib"] });
    const replaced = await read(root, "references.bib");
    expect(replaced).not.toContain("mine2020");
    expect(replaced).toContain("lovelace1843sketch");
  });

  it("reports where a failed write kept the earlier text, until that copy is removed", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");
    await syncManagedBibliography(root);
    const earlier = await read(root, "references.bib");
    const bibPath = NodePath.join(await NodeFSP.realpath(root), "references.bib");
    await add(root, "B", "Sketch of the engine");
    const failed = await (async () => {
      using _diskFull = overrideFileSystem((original) => ({
        link: async (source, destination) => {
          if (destination === bibPath) throw nodeError("ENOSPC");
          return original.link(source, destination);
        },
      }));
      return await syncManagedBibliography(root);
    })();

    const kept = failed.files[0]?.kept ?? [];
    expect(failed.files[0]).toMatchObject({
      name: "references.bib",
      state: "edited",
      changes: null,
    });
    expect(kept).toEqual([expect.stringMatching(/^references\.bib\.kept-[0-9a-f]{8}$/u)]);
    expect(await read(root, kept[0] ?? "")).toBe(earlier);

    const recovered = await syncManagedBibliography(root);
    expect(recovered.files[0]).toMatchObject({ state: "current", kept });
    await NodeFSP.rm(NodePath.join(root, kept[0] ?? ""));
    expect((await syncManagedBibliography(root)).files[0]).toEqual({
      name: "references.bib",
      state: "current",
      changes: null,
    });
  });

  it("writes by exclusive copy where hard links are missing, and removes a copy that fails part way", async () => {
    const root = await project();
    const bibPath = NodePath.join(await NodeFSP.realpath(root), "references.bib");
    await add(root, "A", "Notes on the analytical engine");
    let failingWrites = 1;
    using _noHardLinks = overrideFileSystem((original) => ({
      // What Windows reports for a hard link on a FAT or exFAT volume; the Library's own store keeps its links.
      link: async (source, destination) => {
        if (NodePath.dirname(String(destination)) === NodePath.dirname(bibPath)) {
          throw nodeError("EISDIR");
        }
        return original.link(source, destination);
      },
      open: async (path, flags, mode) => {
        const handle = await original.open(path, flags, mode);
        if (path !== bibPath || flags !== "wx" || failingWrites-- <= 0) return handle;
        return new Proxy(handle, {
          get: (target, key) => {
            if (key === "writeFile") {
              return async (data: Uint8Array) => {
                await target.write(data.subarray(0, 8));
                throw nodeError("ENOSPC");
              };
            }
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    }));
    const strays = async () =>
      (await NodeFSP.readdir(root)).filter((name) => name.includes("references."));

    await expect(syncManagedBibliography(root)).rejects.toThrow("synthetic ENOSPC");
    expect(await strays()).toEqual([]);

    const written = await syncManagedBibliography(root);
    expect(written.files.map((file) => file.state)).toEqual(["current", "current"]);
    await add(root, "B", "Sketch of the engine");
    expect((await syncManagedBibliography(root)).files[0]?.state).toBe("current");
    expect(await read(root, "references.bib")).toContain("@article{lovelace1843sketch,");
    expect(await strays()).toEqual(["references.bib", "references.json"]);
  });

  it("leaves another writer's file in place when a copy that fails part way is removed", async () => {
    const root = await project();
    const bibPath = NodePath.join(await NodeFSP.realpath(root), "references.bib");
    const theirs = "@misc{theirs2020,\n  title = {Theirs},\n}\n";
    await add(root, "A", "Notes on the analytical engine");
    let failingWrites = 1;
    let otherWriterArmed = false;
    using _noHardLinks = overrideFileSystem((original) => ({
      link: async (source, destination) => {
        if (NodePath.dirname(String(destination)) === NodePath.dirname(bibPath)) {
          throw nodeError("EPERM");
        }
        return original.link(source, destination);
      },
      open: async (path, flags, mode) => {
        const handle = await original.open(path, flags, mode);
        if (path !== bibPath || flags !== "wx" || failingWrites-- <= 0) return handle;
        return new Proxy(handle, {
          get: (target, key) => {
            if (key === "writeFile") {
              return async (data: Uint8Array) => {
                await target.write(data.subarray(0, 8));
                otherWriterArmed = true;
                throw nodeError("ENOSPC");
              };
            }
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      // Another writer replaces the managed name right after cleanup checks which file it holds.
      lstat: (async (...args: Parameters<typeof NodeFSP.lstat>) => {
        const stats = await original.lstat(...args);
        if (otherWriterArmed) {
          otherWriterArmed = false;
          const other = `${bibPath}.other`;
          await NodeFSP.writeFile(other, theirs);
          await NodeFSP.rename(other, bibPath);
        }
        return stats;
      }) as typeof NodeFSP.lstat,
    }));

    await expect(syncManagedBibliography(root)).rejects.toThrow("synthetic ENOSPC");
    expect(await read(root, "references.bib")).toBe(theirs);
    expect((await NodeFSP.readdir(root)).filter((name) => name.includes("references."))).toEqual([
      "references.bib",
    ]);
  });

  it("imports entries added by hand and keeps a file with changed entries", async () => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");
    await syncManagedBibliography(root);
    const bibPath = NodePath.join(root, "references.bib");
    const written = await read(root, "references.bib");
    await NodeFSP.writeFile(
      bibPath,
      `${written}\n@book{babbage1864passages,\n  author = {Babbage, Charles},\n  title = {Passages from the Life of a Philosopher},\n  year = {1864},\n}\n`,
    );

    const imported = await syncManagedBibliographyWithImports({
      root,
      importEdited: ["references.bib"],
      actor: "user",
    });
    expect(imported.imported).toBe(1);
    expect(imported.files[0]?.state).toBe("current");
    expect(await read(root, "references.bib")).toContain("@book{babbage1864passages,");

    const changed = (await read(root, "references.bib")).replace(
      "Passages from the Life of a Philosopher",
      "Passages",
    );
    await NodeFSP.writeFile(bibPath, changed);
    const kept = await syncManagedBibliographyWithImports({
      root,
      importEdited: ["references.bib"],
      actor: "user",
    });
    expect(kept.files[0]).toMatchObject({
      state: "edited",
      changes: { changed: ["babbage1864passages"] },
    });
    expect(await read(root, "references.bib")).toBe(changed);
  });

  it("never writes over a file Scient did not write", async () => {
    const root = await project();
    await NodeFSP.writeFile(NodePath.join(root, "references.bib"), "@misc{own,\n}\n");
    await add(root, "A", "Notes on the analytical engine");

    const status = await syncManagedBibliography(root, { replaceEdited: ["references.bib"] });
    expect(status.files[0]?.state).toBe("unmanaged");
    expect(await read(root, "references.bib")).toBe("@misc{own,\n}\n");
  });

  it.each([
    { name: "a file created", before: null, landed: "@misc{own,\n}\n", state: "unmanaged" },
    { name: "a hand edit saved", before: "synced", landed: "% mine\n", state: "edited" },
  ] as const)("keeps $name while it publishes", async ({ before, landed, state }) => {
    const root = await project();
    await add(root, "A", "Notes on the analytical engine");
    if (before) await syncManagedBibliography(root);
    await add(root, "B", "Sketch of the engine");
    const bibPath = NodePath.join(root, "references.bib");
    scientProjectFilePublicationHooks.beforeReplace = async (filePath) => {
      if (NodePath.basename(filePath) !== "references.bib") return;
      scientProjectFilePublicationHooks.beforeReplace = null;
      await NodeFSP.writeFile(bibPath, landed);
    };
    try {
      const status = await syncManagedBibliography(root);
      expect(status.files[0]?.state).toBe(state);
    } finally {
      scientProjectFilePublicationHooks.beforeReplace = null;
    }
    expect(await read(root, "references.bib")).toBe(landed);
    expect((await NodeFSP.readdir(root)).filter((name) => name.includes("references.bib"))).toEqual(
      ["references.bib"],
    );
  });

  it("never writes its copies through a linked folder", async () => {
    const root = await project();
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-outside-"));
    fixtures.push(outside);
    await add(root, "A", "Notes on the analytical engine");
    await NodeFSP.symlink(
      outside,
      NodePath.join(root, ".scient", "sources", "bibliography"),
      "junction",
    );

    const status = await syncManagedBibliography(root);
    expect(status.files.map((file) => file.state)).toEqual(["unmanaged", "unmanaged"]);
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("gives sources written before citation keys existed a key, oldest first", async () => {
    const root = await project();
    const identity = await readScientProjectIdentity(root);
    const recordsDirectory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
    await NodeFSP.mkdir(recordsDirectory, { recursive: true });
    for (const [sourceId, importedAt] of [
      ["source_new", "2026-02-01T00:00:00.000Z"],
      ["source_old", "2026-01-01T00:00:00.000Z"],
    ] as const) {
      const {
        sourceKey: _key,
        pdfAvailable: _a,
        pdfFileName: _b,
        pdfAttachmentCount: _c,
        ...rest
      } = sourceCandidate(sourceId, "Notes");
      await NodeFSP.writeFile(
        NodePath.join(recordsDirectory, `${sourceId}.json`),
        JSON.stringify({
          formatVersion: 1,
          sourceId,
          projectId: identity.projectId,
          revision: 1,
          ...rest,
          attachments: [],
          importedAt,
        }),
      );
    }

    await syncManagedBibliography(root);

    const old = await readScientSourceRecord(root, "source_old");
    const newer = await readScientSourceRecord(root, "source_new");
    expect(old).toMatchObject({ citationKey: "lovelace1843notes", revision: 2 });
    expect(newer).toMatchObject({ citationKey: "lovelace1843notesa", revision: 2 });
  });
});
