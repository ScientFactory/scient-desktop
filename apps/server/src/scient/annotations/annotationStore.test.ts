// @effect-diagnostics nodeBuiltinImport:off -- Store tests inspect the files the store writes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { ScientAnnotationCommand } from "@t3tools/contracts";

import {
  applyAnnotationCommand,
  listScientAnnotationFiles,
  MAX_ANNOTATIONS_PER_PDF,
  mutateScientAnnotations,
  readScientAnnotationFile,
  type ScientAnnotationFile,
} from "./annotationStore.ts";
import { readerAnchor, temporaryProject } from "./annotationTestUtils.ts";

const material = { sha256: "a".repeat(64), byteLength: 1_234 };
const text = "Mitochondria are the powerhouse of the cell.\nThey make ATP.\n";
const anchor = readerAnchor({ text, quote: "powerhouse of the cell" });

function emptyFile(): ScientAnnotationFile {
  return { formatVersion: 1, material, paths: [], annotations: [], history: [] };
}

function apply(
  file: ScientAnnotationFile,
  command: ScientAnnotationCommand,
  actor: "user" | "agent" = "user",
) {
  return applyAnnotationCommand(file, command, actor, "2026-11-10T12:00:00.000Z");
}

const create = (annotationId = "ann_00000001", note = ""): ScientAnnotationCommand => ({
  action: "create",
  annotationId,
  anchor,
  highlighted: true,
  note,
});

describe("applyAnnotationCommand", () => {
  it("creates a highlight credited to its actor and replays the same create unchanged", () => {
    const first = apply(emptyFile(), create(), "agent");
    expect(first.result.outcome).toBe("created");
    expect(first.result.annotation).toMatchObject({
      revision: 1,
      createdBy: "agent",
      updatedBy: "agent",
      deletedAt: null,
    });
    const replay = apply(first.file, create(), "agent");
    expect(replay.changed).toBe(false);
    expect(replay.result.outcome).toBe("unchanged");
  });

  it("refuses an annotation with neither a highlight nor a note", () => {
    const result = apply(emptyFile(), {
      action: "create",
      annotationId: "ann_00000001",
      anchor,
      highlighted: false,
      note: "  \n ",
    });
    expect(result.result.outcome).toBe("empty");
    expect(result.changed).toBe(false);
  });

  it("returns the current annotation instead of writing over a newer revision", () => {
    const created = apply(emptyFile(), create());
    const edited = apply(created.file, {
      action: "update",
      annotationId: "ann_00000001",
      expectedRevision: 1,
      note: "Key claim",
    });
    expect(edited.result).toMatchObject({ outcome: "updated", annotation: { revision: 2 } });
    const stale = apply(edited.file, {
      action: "update",
      annotationId: "ann_00000001",
      expectedRevision: 1,
      note: "Older edit",
    });
    expect(stale.changed).toBe(false);
    expect(stale.result).toMatchObject({ outcome: "stale", annotation: { note: "Key claim" } });
  });

  it("removes to a tombstone that restore brings back", () => {
    const created = apply(emptyFile(), create());
    const removed = apply(created.file, {
      action: "remove",
      annotationId: "ann_00000001",
      expectedRevision: 1,
    });
    expect(removed.result.annotation?.deletedAt).toBe("2026-11-10T12:00:00.000Z");
    expect(removed.file.annotations).toHaveLength(1);
    const restored = apply(removed.file, {
      action: "restore",
      annotationId: "ann_00000001",
      expectedRevision: 2,
    });
    expect(restored.result).toMatchObject({
      outcome: "restored",
      annotation: { revision: 3, deletedAt: null },
    });
  });

  it("reverts to an earlier revision as a new revision and keeps a bounded history", () => {
    let file = apply(emptyFile(), create("ann_00000001", "first")).file;
    for (let revision = 1; revision <= 12; revision += 1) {
      file = apply(
        file,
        {
          action: "update",
          annotationId: "ann_00000001",
          expectedRevision: revision,
          note: `note ${revision + 1}`,
        },
        "agent",
      ).file;
    }
    expect(file.history.filter((entry) => entry.annotationId === "ann_00000001")).toHaveLength(10);
    const reverted = apply(file, {
      action: "revert",
      annotationId: "ann_00000001",
      expectedRevision: 13,
      toRevision: 12,
    });
    expect(reverted.result).toMatchObject({
      outcome: "updated",
      annotation: { revision: 14, note: "note 12", updatedBy: "user" },
    });
    expect(
      apply(file, {
        action: "revert",
        annotationId: "ann_00000001",
        expectedRevision: 13,
        toRevision: 1,
      }).result.outcome,
    ).toBe("not-found");
  });

  it("stops creating at the per-PDF limit", () => {
    const full = {
      ...emptyFile(),
      annotations: Array.from({ length: MAX_ANNOTATIONS_PER_PDF }, (_, index) => ({
        ...apply(emptyFile(), create(`ann_${String(index).padStart(8, "0")}`)).result.annotation!,
      })),
    };
    expect(apply(full, create("ann_overflow1")).result.outcome).toBe("limit-reached");
  });
});

describe("annotation files", () => {
  it("writes one file per PDF hash and remembers where the PDF was annotated", async () => {
    await using project = await temporaryProject();
    const result = await mutateScientAnnotations({
      canonicalRoot: project.root,
      material,
      relativePath: "papers/cell.pdf",
      command: create(),
      actor: "user",
      now: "2026-11-10T12:00:00.000Z",
    });
    expect(result.outcome).toBe("created");
    const filePath = NodePath.join(
      project.root,
      ".scient",
      "annotations",
      "v1",
      `${material.sha256}.json`,
    );
    const stored = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
    expect(stored).toMatchObject({ formatVersion: 1, material, paths: ["papers/cell.pdf"] });
    expect((await readScientAnnotationFile(project.root, material.sha256))?.annotations).toEqual([
      result.annotation,
    ]);
  });

  it("never overwrites a damaged file and lists the others around it", async () => {
    await using project = await temporaryProject();
    await mutateScientAnnotations({
      canonicalRoot: project.root,
      material,
      relativePath: null,
      command: create(),
      actor: "user",
      now: "2026-11-10T12:00:00.000Z",
    });
    const directory = NodePath.join(project.root, ".scient", "annotations", "v1");
    const damaged = NodePath.join(directory, `${"b".repeat(64)}.json`);
    await NodeFSP.writeFile(damaged, "{ not json");
    await expect(
      mutateScientAnnotations({
        canonicalRoot: project.root,
        material: { sha256: "b".repeat(64), byteLength: 10 },
        relativePath: null,
        command: create("ann_00000002"),
        actor: "user",
        now: "2026-11-10T12:00:00.000Z",
      }),
    ).rejects.toThrow();
    expect(await NodeFSP.readFile(damaged, "utf8")).toBe("{ not json");
    const listing = await listScientAnnotationFiles(project.root);
    expect(listing.files.map((file) => file.material.sha256)).toEqual([material.sha256]);
    expect(listing.unreadable).toEqual([`${"b".repeat(64)}.json`]);
  });

  it("serializes concurrent creates on one PDF so none is lost", async () => {
    await using project = await temporaryProject();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        mutateScientAnnotations({
          canonicalRoot: project.root,
          material,
          relativePath: null,
          command: create(`ann_${String(index).padStart(8, "0")}`),
          actor: "user",
          now: "2026-11-10T12:00:00.000Z",
        }),
      ),
    );
    expect(
      (await readScientAnnotationFile(project.root, material.sha256))?.annotations,
    ).toHaveLength(12);
  });

  it("never reads or writes through a symlinked annotation folder", async () => {
    await using project = await temporaryProject();
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-outside-"));
    await using _cleanup = {
      [Symbol.asyncDispose]: () => NodeFSP.rm(outside, { recursive: true, force: true }),
    };
    const stored = `${JSON.stringify({ ...emptyFile(), paths: ["outside.pdf"] })}\n`;
    await NodeFSP.mkdir(NodePath.join(outside, "v1"));
    await NodeFSP.writeFile(NodePath.join(outside, "v1", `${material.sha256}.json`), stored);
    const write = () =>
      mutateScientAnnotations({
        canonicalRoot: project.root,
        material,
        relativePath: null,
        command: create(),
        actor: "user",
        now: "2026-11-10T12:00:00.000Z",
      });
    const parent = NodePath.join(project.root, ".scient", "annotations");
    for (const link of [parent, NodePath.join(parent, "v1")]) {
      await NodeFSP.rm(parent, { recursive: true, force: true });
      if (link !== parent) await NodeFSP.mkdir(parent);
      await NodeFSP.symlink(link === parent ? outside : NodePath.join(outside, "v1"), link);
      await expect(readScientAnnotationFile(project.root, material.sha256)).rejects.toThrow();
      await expect(listScientAnnotationFiles(project.root)).rejects.toThrow();
      await expect(write()).rejects.toThrow();
    }
    expect(await NodeFSP.readdir(NodePath.join(outside, "v1"))).toEqual([
      `${material.sha256}.json`,
    ]);
    expect(
      await NodeFSP.readFile(NodePath.join(outside, "v1", `${material.sha256}.json`), "utf8"),
    ).toBe(stored);
  });

  it("refuses a file that records another PDF and leaves it as it was", async () => {
    await using project = await temporaryProject();
    const directory = NodePath.join(project.root, ".scient", "annotations", "v1");
    await NodeFSP.mkdir(directory, { recursive: true });
    const filePath = NodePath.join(directory, `${material.sha256}.json`);
    const misnamed = `${JSON.stringify({
      ...apply(emptyFile(), create()).file,
      material: { ...material, sha256: "b".repeat(64) },
    })}\n`;
    await NodeFSP.writeFile(filePath, misnamed);
    await expect(readScientAnnotationFile(project.root, material.sha256)).rejects.toThrow();
    await expect(
      mutateScientAnnotations({
        canonicalRoot: project.root,
        material,
        relativePath: null,
        command: {
          action: "update",
          annotationId: "ann_00000001",
          expectedRevision: 1,
          note: "x",
        },
        actor: "user",
        now: "2026-11-10T12:00:00.000Z",
      }),
    ).rejects.toThrow();
    expect(await NodeFSP.readFile(filePath, "utf8")).toBe(misnamed);
  });

  it("treats a file with an absolute path hint as unreadable", async () => {
    await using project = await temporaryProject();
    const directory = NodePath.join(project.root, ".scient", "annotations", "v1");
    await NodeFSP.mkdir(directory, { recursive: true });
    for (const [index, hint] of [
      "/private/secret.pdf",
      "C:\\secret.pdf",
      "\\\\host\\share\\secret.pdf",
      "papers/../../secret.pdf",
    ].entries()) {
      const sha256 = String(index).repeat(64);
      await NodeFSP.writeFile(
        NodePath.join(directory, `${sha256}.json`),
        JSON.stringify({ ...emptyFile(), material: { ...material, sha256 }, paths: [hint] }),
      );
    }
    const listing = await listScientAnnotationFiles(project.root);
    expect(listing.files).toEqual([]);
    expect(listing.unreadable).toHaveLength(4);
  });
});
