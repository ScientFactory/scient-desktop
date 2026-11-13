// @effect-diagnostics nodeBuiltinImport:off -- Exercises folder changes in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  FolderHistoryError,
  latestHistory,
  removeFolder,
  restoreFolder,
  writeFolder,
} from "./FolderHistory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-folder-history-"));
  roots.push(root);
  return { root: NodePath.join(root, "items"), historyRoot: NodePath.join(root, "history") };
};

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (path: string) => NodeFSP.readFile(path, "utf8");

describe("FolderHistory", () => {
  it("undoes a replace, then the creation", async () => {
    const where = await scratch();
    const write = (text: string, stamp: string, meta?: string) =>
      writeFolder({
        ...where,
        name: "item",
        key: "item-id",
        source: { files: { "a/file.txt": bytes(text) } },
        stamp,
        ...(meta === undefined ? {} : { meta: bytes(meta) }),
      });
    expect(await write("one", "s1")).toEqual({ created: true });
    expect(await write("two", "s2", "before two")).toEqual({ created: false });
    expect(await read(NodePath.join(where.root, "item/a/file.txt"))).toBe("two");

    const replaced = await restoreFolder({ ...where, name: "item", key: "item-id" });
    expect(replaced.kind).toBe("replaced");
    expect(new TextDecoder().decode(replaced.meta)).toBe("before two");
    expect(await read(NodePath.join(where.root, "item/a/file.txt"))).toBe("one");

    expect((await restoreFolder({ ...where, name: "item", key: "item-id" })).kind).toBe("created");
    await expect(NodeFSP.stat(NodePath.join(where.root, "item"))).rejects.toThrow();
    await expect(restoreFolder({ ...where, name: "item", key: "item-id" })).rejects.toMatchObject({
      reason: "no-history",
    });
  });

  it("brings a removed folder back, and records a removal kept in place", async () => {
    const where = await scratch();
    await writeFolder({
      ...where,
      name: "item",
      source: { files: { f: bytes("x") } },
      stamp: "s1",
    });
    await removeFolder({ ...where, name: "item", stamp: "s2" });
    await expect(NodeFSP.stat(NodePath.join(where.root, "item"))).rejects.toThrow();
    expect((await restoreFolder({ ...where, name: "item" })).kind).toBe("removed");
    expect(await read(NodePath.join(where.root, "item/f"))).toBe("x");

    // A folder Scient does not own stays where it is; only what it was is kept.
    await removeFolder({
      ...where,
      name: "item",
      stamp: "s3",
      meta: bytes("m"),
      keepInPlace: true,
    });
    expect(await read(NodePath.join(where.root, "item/f"))).toBe("x");
    const latest = await latestHistory(where.historyRoot, "item");
    expect(latest).toMatchObject({ kind: "removed", folder: undefined });
    const undone = await restoreFolder({ ...where, name: "item" });
    expect(new TextDecoder().decode(undone.meta)).toBe("m");
    expect(await read(NodePath.join(where.root, "item/f"))).toBe("x");
  });

  it("copies a folder, keeps changes within one stamp in order, and keeps ten", async () => {
    const where = await scratch();
    const source = NodePath.join(where.root, "..", "source");
    await NodeFSP.mkdir(NodePath.join(source, ".git"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "manifest.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(source, ".git", "HEAD"), "ref");
    for (let index = 0; index < 12; index++) {
      await writeFolder({
        ...where,
        name: "item",
        source: { copyFrom: source, skip: new Set([".git"]) },
        stamp: "same",
        meta: bytes(String(index)),
      });
    }
    expect(await read(NodePath.join(where.root, "item/manifest.json"))).toBe("{}");
    await expect(NodeFSP.stat(NodePath.join(where.root, "item/.git"))).rejects.toThrow();
    const kept = (await NodeFSP.readdir(NodePath.join(where.historyRoot, "item"))).filter(
      (name) => !name.endsWith(".meta"),
    );
    expect(kept).toHaveLength(10);
    const latest = await latestHistory(where.historyRoot, "item");
    expect(new TextDecoder().decode(latest?.meta)).toBe("11");
  });

  it("keeps fewer versions of a large folder, newest first and with no gap", async () => {
    const where = await scratch();
    const write = (index: number, size: number) =>
      writeFolder({
        ...where,
        name: "item",
        source: { files: { "big.bin": new Uint8Array(size) } },
        stamp: `s${index}`,
        meta: bytes(String(index)),
        historyBytes: 1_000,
      });
    await write(0, 10);
    for (let index = 1; index <= 4; index++) await write(index, 400);
    // regression: ten versions were kept whatever their size. The two newest fit; all older go.
    const kept = (await NodeFSP.readdir(NodePath.join(where.historyRoot, "item"))).filter(
      (name) => !name.endsWith(".meta"),
    );
    expect(kept).toEqual(["s3-replaced", "s4-replaced"]);
  });

  it("refuses a file outside the folder and leaves nothing behind", async () => {
    const where = await scratch();
    await expect(
      writeFolder({
        ...where,
        name: "item",
        source: { files: { "../x": bytes("x") } },
        stamp: "s",
      }),
    ).rejects.toBeInstanceOf(FolderHistoryError);
    expect(await NodeFSP.readdir(where.root)).toEqual([]);
    expect(await latestHistory(where.historyRoot, "item")).toBeUndefined();
  });
});
