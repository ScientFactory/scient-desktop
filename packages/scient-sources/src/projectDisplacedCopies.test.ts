// @effect-diagnostics nodeBuiltinImport:off -- This test verifies the Node filesystem adapter.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  countScientDisplacedCopiesInProject,
  keepScientDisplacedCopies,
  readScientDisplacedCopiesOf,
  scientValuesChangedBy,
} from "./projectDisplacedCopies.ts";
import { readScientDisplacedCopies } from "./testing/displacedCopies.ts";

vi.mock("node:fs/promises", { spy: true });

const fixtures: string[] = [];

const fixture = async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-displaced-")),
  );
  fixtures.push(root);
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const copy = (heldBy: string, undoneAt: string, title: string) => ({
  sourceId: "source_a",
  heldBy,
  undoneAt,
  differs: ["title"],
  work: { title },
});

describe("copies a project held and a merge Undo replaced", () => {
  it("keeps one per holder, source and Undo, without a cap, and never overwrites a file it cannot read", async () => {
    const root = await fixture();
    const holder = { kind: "project" } as const;
    const first = "2026-11-01T00:00:00.000Z";

    // 300 keys in one refresh: every one is still there afterwards.
    await keepScientDisplacedCopies(
      root,
      holder,
      Array.from({ length: 300 }, (_, index) => copy(`key${index}`, first, `Title ${index}`)),
    );
    expect(await readScientDisplacedCopies(root, holder)).toHaveLength(300);

    // The same Undo again adds nothing, even with other contents; a later Undo adds its own.
    await keepScientDisplacedCopies(root, holder, [copy("key0", first, "Edited since")]);
    await keepScientDisplacedCopies(root, holder, [
      copy("key0", "2026-11-02T00:00:00.000Z", "After the second Undo"),
    ]);
    const kept = await readScientDisplacedCopies(root, holder);
    expect(kept).toHaveLength(301);
    expect(kept.filter((entry) => entry.heldBy === "key0").map((entry) => entry.work)).toEqual([
      { title: "Title 0" },
      { title: "After the second Undo" },
    ]);

    // A review's copies are in that review's own file.
    const review = { kind: "review", reviewId: "review_1" } as const;
    await keepScientDisplacedCopies(root, review, [copy("review_1", first, "In a review")]);
    expect(await readScientDisplacedCopies(root, review)).toHaveLength(1);
    expect(await readScientDisplacedCopies(root, holder)).toHaveLength(301);

    // An unreadable file is moved aside with its bytes, and a new one is started.
    const folder = NodePath.join(root, ".scient", "library", "displaced");
    await NodeFSP.writeFile(NodePath.join(folder, "project.json"), "{ not json");
    await keepScientDisplacedCopies(root, holder, [copy("key0", first, "After damage")]);
    expect(await readScientDisplacedCopies(root, holder)).toMatchObject([
      { work: { title: "After damage" } },
    ]);
    const aside = (await NodeFSP.readdir(folder)).filter((name) =>
      name.startsWith("project.json.unreadable-"),
    );
    expect(aside).toHaveLength(1);
    expect(await NodeFSP.readFile(NodePath.join(folder, aside[0]!), "utf8")).toBe("{ not json");

    // Read across the project: each copy with its kind of holder, and the files it could not read.
    await NodeFSP.writeFile(NodePath.join(folder, "reviews", "review_2.json"), "[");
    const all = await readScientDisplacedCopiesOf(root, "source_a");
    expect(all.map((entry) => [entry.holder, entry.heldBy, entry.work])).toEqual([
      ["citation-key", "key0", { title: "After damage" }],
      ["review", "review_1", { title: "In a review" }],
    ]);
    expect(await readScientDisplacedCopiesOf(root, "source_b")).toEqual([]);
    expect(await countScientDisplacedCopiesInProject(root)).toEqual({ copies: 2, unreadable: 2 });
  });

  it("never reads or writes through a linked folder into another checkout", async () => {
    const base = await fixture();
    const [root, other] = [NodePath.join(base, "project"), NodePath.join(base, "other")];
    await Promise.all([root, other].map((folder) => NodeFSP.mkdir(folder)));
    const first = "2026-11-01T00:00:00.000Z";
    await keepScientDisplacedCopies(other, { kind: "project" }, [copy("key0", first, "Other")]);
    await keepScientDisplacedCopies(other, { kind: "review", reviewId: "review_1" }, [
      copy("review_1", first, "Other review"),
    ]);
    const otherFolder = NodePath.join(other, ".scient", "library", "displaced");
    const before = await NodeFSP.readFile(NodePath.join(otherFolder, "project.json"), "utf8");
    // The link is above the kept-copy folder, where a check of the file alone would not look.
    await NodeFSP.mkdir(NodePath.join(root, ".scient"));
    await NodeFSP.symlink(
      NodePath.join(other, ".scient", "library"),
      NodePath.join(root, ".scient", "library"),
      "dir",
    );

    expect(await readScientDisplacedCopiesOf(root, "source_a")).toEqual([]);
    expect(await countScientDisplacedCopiesInProject(root)).toEqual({ copies: 0, unreadable: 1 });
    await expect(readScientDisplacedCopies(root, { kind: "project" })).rejects.toThrow(
      "not a safe directory",
    );
    await expect(
      keepScientDisplacedCopies(root, { kind: "project" }, [copy("key1", first, "Here")]),
    ).rejects.toThrow("not a safe directory");
    expect(await NodeFSP.readdir(otherFolder)).toEqual(["project.json", "reviews"]);
    expect(await NodeFSP.readFile(NodePath.join(otherFolder, "project.json"), "utf8")).toBe(before);
  });

  it("refuses a displaced folder replaced with a symlink mid-read or mid-keep without renaming the target", async () => {
    const root = await fixture();
    const other = await fixture();
    const first = "2026-11-01T00:00:00.000Z";
    const second = "2026-11-02T00:00:00.000Z";
    const displaced = NodePath.join(root, ".scient", "library", "displaced");
    const otherFolder = NodePath.join(other, ".scient", "library", "displaced");
    await keepScientDisplacedCopies(root, { kind: "project" }, [copy("key1", first, "Local")]);
    await keepScientDisplacedCopies(other, { kind: "project" }, [copy("otherKey", first, "Other")]);
    const otherFile = NodePath.join(otherFolder, "project.json");
    const otherBefore = await NodeFSP.readFile(otherFile, "utf8");

    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    // Swap the displaced directory to a symlink to another checkout right when open() runs.
    let swapped = false;
    vi.spyOn(NodeFSP, "open").mockImplementation((async (
      path: Parameters<typeof actual.open>[0],
      flags?: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      if (!swapped && path === NodePath.join(displaced, "project.json")) {
        swapped = true;
        await actual.rm(displaced, { recursive: true, force: true });
        await actual.symlink(otherFolder, displaced, "dir");
      }
      return actual.open(path, flags, mode);
    }) as typeof actual.open);

    await expect(readScientDisplacedCopies(root, { kind: "project" })).rejects.toThrow(
      "not a safe directory",
    );
    expect(await readScientDisplacedCopiesOf(root, "source_a")).toEqual([]);
    expect(await countScientDisplacedCopiesInProject(root)).toEqual({ copies: 0, unreadable: 1 });

    // Restore a real folder and repeat the mid-operation swap during keepScientDisplacedCopies:
    // the second checkout's file must not be quarantined or overwritten.
    await actual.rm(displaced, { recursive: true, force: true });
    await actual.mkdir(displaced, { recursive: true });
    await actual.writeFile(NodePath.join(displaced, "project.json"), "{ not valid json");
    swapped = false;
    await expect(
      keepScientDisplacedCopies(root, { kind: "project" }, [copy("key2", second, "Here")]),
    ).rejects.toThrow("not a safe directory");
    expect(await actual.readdir(otherFolder)).toEqual(["project.json"]);
    expect(await actual.readFile(otherFile, "utf8")).toBe(otherBefore);
  });

  it("handles a displaced directory that disappears or cannot be listed without throwing", async () => {
    const root = await fixture();
    const first = "2026-11-01T00:00:00.000Z";
    await keepScientDisplacedCopies(root, { kind: "project" }, [copy("key1", first, "Local")]);
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");

    // Directory disappears between validation and readdir -> treated as absent.
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    vi.spyOn(NodeFSP, "readdir").mockImplementationOnce((async () => {
      throw enoent;
    }) as typeof actual.readdir);
    expect(await countScientDisplacedCopiesInProject(root)).toEqual({ copies: 0, unreadable: 0 });
    expect(await readScientDisplacedCopiesOf(root, "source_a")).toEqual([
      expect.objectContaining({ heldBy: "key1" }),
    ]);

    // Directory cannot be listed -> counted as one unreadable folder, never throws.
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.spyOn(NodeFSP, "readdir").mockImplementationOnce((async () => {
      throw eacces;
    }) as typeof actual.readdir);
    expect(await countScientDisplacedCopiesInProject(root)).toEqual({ copies: 0, unreadable: 1 });
  });

  it("refuses a displaced folder swapped at temp-file open, before final rename, or before quarantine rename", async () => {
    const first = "2026-11-01T00:00:00.000Z";
    const second = "2026-11-02T00:00:00.000Z";
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");

    // 1. Swap right when opening the temporary file during writeVerifiedJson.
    {
      const root = await fixture();
      const other = await fixture();
      const displaced = NodePath.join(root, ".scient", "library", "displaced");
      const otherFolder = NodePath.join(other, ".scient", "library", "displaced");
      await keepScientDisplacedCopies(other, { kind: "project" }, [
        copy("otherKey", first, "Other"),
      ]);
      const otherBefore = await actual.readFile(NodePath.join(otherFolder, "project.json"), "utf8");

      let swapped = false;
      vi.spyOn(NodeFSP, "open").mockImplementation((async (
        path: Parameters<typeof actual.open>[0],
        flags?: Parameters<typeof actual.open>[1],
        mode?: Parameters<typeof actual.open>[2],
      ) => {
        if (!swapped && typeof path === "string" && path.includes("project.json.tmp-")) {
          swapped = true;
          await actual.rm(displaced, { recursive: true, force: true });
          await actual.symlink(otherFolder, displaced, "dir");
        }
        return actual.open(path, flags, mode);
      }) as typeof actual.open);

      await expect(
        keepScientDisplacedCopies(root, { kind: "project" }, [copy("key1", first, "Secret")]),
      ).rejects.toThrow("not a safe directory");
      expect(await actual.readdir(otherFolder)).toEqual(["project.json"]);
      expect(await actual.readFile(NodePath.join(otherFolder, "project.json"), "utf8")).toBe(
        otherBefore,
      );
      vi.restoreAllMocks();
    }

    // 2. Swap right before final rename (after temp file was written in the original folder).
    {
      const root = await fixture();
      const other = await fixture();
      const displaced = NodePath.join(root, ".scient", "library", "displaced");
      const otherFolder = NodePath.join(other, ".scient", "library", "displaced");
      await keepScientDisplacedCopies(other, { kind: "project" }, [
        copy("otherKey", first, "Other"),
      ]);
      const otherBefore = await actual.readFile(NodePath.join(otherFolder, "project.json"), "utf8");

      let sawTempOpen = false;
      let swapped = false;
      vi.spyOn(NodeFSP, "open").mockImplementation((async (
        path: Parameters<typeof actual.open>[0],
        flags?: Parameters<typeof actual.open>[1],
        mode?: Parameters<typeof actual.open>[2],
      ) => {
        const handle = await actual.open(path, flags, mode);
        if (typeof path === "string" && path.includes("project.json.tmp-")) {
          sawTempOpen = true;
        }
        return handle;
      }) as typeof actual.open);
      const origRealpath = actual.realpath;
      vi.spyOn(NodeFSP, "realpath").mockImplementation((async (
        path: Parameters<typeof actual.realpath>[0],
      ) => {
        if (sawTempOpen && !swapped && path === displaced) {
          // Second verification after temp write (before rename): swap now.
          const files = await actual.readdir(displaced).catch(() => [] as string[]);
          const tempName = files.find((name) => name.includes("project.json.tmp-"));
          if (tempName) {
            const stat = await actual.stat(NodePath.join(displaced, tempName));
            if (stat.size > 0) {
              swapped = true;
              await actual.rm(displaced, { recursive: true, force: true });
              await actual.symlink(otherFolder, displaced, "dir");
            }
          }
        }
        return origRealpath(path);
      }) as typeof actual.realpath);

      await expect(
        keepScientDisplacedCopies(root, { kind: "project" }, [copy("key1", second, "Here")]),
      ).rejects.toThrow("not a safe directory");
      expect(await actual.readdir(otherFolder)).toEqual(["project.json"]);
      expect(await actual.readFile(NodePath.join(otherFolder, "project.json"), "utf8")).toBe(
        otherBefore,
      );
      vi.restoreAllMocks();
    }

    // 3. Swap after reading a corrupt local file and before quarantine rename.
    {
      const root = await fixture();
      const other = await fixture();
      const displaced = NodePath.join(root, ".scient", "library", "displaced");
      const otherFolder = NodePath.join(other, ".scient", "library", "displaced");
      await actual.mkdir(displaced, { recursive: true });
      await actual.writeFile(NodePath.join(displaced, "project.json"), "{ broken");
      await keepScientDisplacedCopies(other, { kind: "project" }, [
        copy("otherKey", first, "Other"),
      ]);
      const otherBefore = await actual.readFile(NodePath.join(otherFolder, "project.json"), "utf8");

      let readDone = false;
      let swapped = false;
      vi.spyOn(NodeFSP, "open").mockImplementation((async (
        path: Parameters<typeof actual.open>[0],
        flags?: Parameters<typeof actual.open>[1],
        mode?: Parameters<typeof actual.open>[2],
      ) => {
        const handle = await actual.open(path, flags, mode);
        if (path === NodePath.join(displaced, "project.json")) readDone = true;
        return handle;
      }) as typeof actual.open);
      const origLstat = actual.lstat;
      let lstatCountAfterOpen = 0;
      vi.spyOn(NodeFSP, "lstat").mockImplementation((async (
        path: Parameters<typeof actual.lstat>[0],
        opts?: Parameters<typeof actual.lstat>[1],
      ) => {
        if (readDone && !swapped && path === displaced) {
          lstatCountAfterOpen += 1;
          // readVerifiedFile stats displaced twice inside sameVerifiedDirectory; 3rd lstat is quarantine's check.
          if (lstatCountAfterOpen >= 3) {
            swapped = true;
            await actual.rm(displaced, { recursive: true, force: true });
            await actual.symlink(otherFolder, displaced, "dir");
          }
        }
        return origLstat(path, opts as never);
      }) as typeof actual.lstat);

      await expect(
        keepScientDisplacedCopies(root, { kind: "project" }, [copy("key2", second, "Here")]),
      ).rejects.toThrow("not a safe directory");
      expect(await actual.readdir(otherFolder)).toEqual(["project.json"]);
      expect(await actual.readFile(NodePath.join(otherFolder, "project.json"), "utf8")).toBe(
        otherBefore,
      );
      vi.restoreAllMocks();
    }
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- collection-time skip for POSIX mkfifo test.
  it.skipIf(NodeOS.platform() === "win32")(
    "refuses a named pipe (FIFO) without blocking details, export counts, or keep",
    async () => {
      const root = await fixture();
      const displaced = NodePath.join(root, ".scient", "library", "displaced");
      await NodeFSP.mkdir(displaced, { recursive: true });
      const fifo = NodePath.join(displaced, "project.json");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);

      await expect(readScientDisplacedCopies(root, { kind: "project" })).rejects.toThrow(
        "not a safe regular file",
      );
      expect(await readScientDisplacedCopiesOf(root, "source_a")).toEqual([]);
      expect(await countScientDisplacedCopiesInProject(root)).toEqual({
        copies: 0,
        unreadable: 1,
      });
      await expect(
        keepScientDisplacedCopies(root, { kind: "project" }, [
          copy("key1", "2026-11-01T00:00:00.000Z", "Secret"),
        ]),
      ).rejects.toThrow("not a safe regular file");
    },
  );

  it("names the fields a replacement changes or drops, not how the copy was captured", () => {
    expect(
      scientValuesChangedBy(
        { title: "A", abstract: "Old", pages: "1-2", capturedAt: "then", tags: [] },
        { title: "A", abstract: "New", pages: null, capturedAt: "now", tags: [] },
      ),
    ).toEqual(["abstract", "pages"]);
  });
});
