// @effect-diagnostics nodeBuiltinImport:off -- This test verifies the Node filesystem adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  keepScientDisplacedCopies,
  readScientDisplacedCopies,
  readScientDisplacedCopiesInProject,
  scientValuesChangedBy,
} from "./projectDisplacedCopies.ts";

const fixtures: string[] = [];

afterEach(async () => {
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
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-displaced-")),
    );
    fixtures.push(root);
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
    const all = await readScientDisplacedCopiesInProject(root);
    expect(all.copies.map((entry) => [entry.holder, entry.heldBy, entry.work])).toEqual([
      ["citation-key", "key0", { title: "After damage" }],
      ["review", "review_1", { title: "In a review" }],
    ]);
    expect(all.unreadable).toBe(2);
  });

  it("names the fields a replacement changes or drops, not how the copy was captured", () => {
    expect(
      scientValuesChangedBy(
        { title: "A", abstract: "Old", pages: "1-2", capturedAt: "then", tags: [] },
        { title: "A", abstract: "New", pages: null, capturedAt: "now", tags: [] },
      ),
    ).toEqual(["abstract", "pages"]);
  });
});
