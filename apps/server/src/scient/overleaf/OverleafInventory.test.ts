// @effect-diagnostics nodeBuiltinImport:off -- Real manuscript folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import {
  captureOverleafInventory,
  OVERLEAF_LIMITS,
  type OverleafInventoryInput,
} from "./OverleafInventory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

async function folder(files: Record<string, string>) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-overleaf-inventory-")),
  );
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), content);
  }
  return root;
}

const capture = (root: string, input: Partial<OverleafInventoryInput> = {}) =>
  captureOverleafInventory({
    folder: root,
    managedPaths: [],
    localOnlyPaths: [],
    selectedAdditions: [],
    requestedPaths: [],
    stagingPaths: [],
    ...input,
  });

async function captured(root: string, input: Partial<OverleafInventoryInput> = {}) {
  const result = await capture(root, input);
  if (result._tag !== "captured") throw new Error(`refused: ${result.refusal.reason}`);
  return result.inventory;
}
const refusal = async (root: string, input: Partial<OverleafInventoryInput> = {}) => {
  const result = await capture(root, input);
  return result._tag === "refused" ? result.refusal : null;
};

describe("captureOverleafInventory", () => {
  it("reads managed files, lists additions and never reads local-only files", async () => {
    const root = await folder({
      "main.tex": "main",
      "figures/plot.pdf": "pdf",
      "notes.md": "notes",
      "main.aux": "aux",
      ".hidden/cache.txt": "hidden",
      ".latexmkrc": "rc",
      "private.txt": "mine",
    });
    const inventory = await captured(root, {
      managedPaths: ["main.tex", "gone.tex"],
      localOnlyPaths: ["private.txt"],
      selectedAdditions: ["notes.md"],
    });
    expect([...inventory.captured.keys()].sort()).toEqual(["main.tex", "notes.md"]);
    expect(inventory.captured.get("main.tex")?.revision).toBe(bytesRevision(Buffer.from("main")));
    expect(inventory.missingManaged).toEqual(["gone.tex"]);
    expect(inventory.localOnly).toEqual(["private.txt"]);
    expect(inventory.additions).toEqual([
      { path: ".hidden/cache.txt", size: 6, checkedByDefault: false, uncheckedReason: "hidden" },
      { path: ".latexmkrc", size: 2, checkedByDefault: true, uncheckedReason: null },
      { path: "figures/plot.pdf", size: 3, checkedByDefault: true, uncheckedReason: null },
      { path: "main.aux", size: 3, checkedByDefault: false, uncheckedReason: "build-output" },
    ]);
    expect(inventory.capturedBytes).toBe(9);
  });

  it("skips repositories, links, droppings, staging and invalid names", async () => {
    const root = await folder({
      "main.tex": "main",
      ".git": "gitdir: elsewhere",
      "vendor/lib/.git/HEAD": "ref",
      "vendor/lib/code.tex": "code",
      ".DS_Store": "x",
      "._main.tex": "x",
      "main.tex.swp": "x",
      ".scient-overleaf-apply-123/main.tex": "x",
      "staged/copy.tex": "x",
      "trailing.": "x",
    });
    await NodeFSP.symlink(NodePath.join(root, "main.tex"), NodePath.join(root, "link.tex"));
    const inventory = await captured(root, {
      managedPaths: ["main.tex"],
      stagingPaths: ["staged/copy.tex"],
    });
    expect(inventory.additions).toEqual([]);
    expect(inventory.excluded).toEqual([
      { path: ".DS_Store", reason: "dropping" },
      { path: "._main.tex", reason: "dropping" },
      { path: ".git", reason: "reserved" },
      { path: ".scient-overleaf-apply-123", reason: "staging" },
      { path: "link.tex", reason: "link" },
      { path: "main.tex.swp", reason: "dropping" },
      { path: "staged/copy.tex", reason: "staging" },
      { path: "trailing.", reason: "invalid-path" },
      { path: "vendor/lib", reason: "repository" },
    ]);
  });

  it("treats a managed file replaced by a folder as missing, and its contents as additions", async () => {
    const root = await folder({ "chapter/one.tex": "one" });
    const inventory = await captured(root, { managedPaths: ["chapter"] });
    expect(inventory.missingManaged).toEqual(["chapter"]);
    expect(inventory.additions.map((addition) => addition.path)).toEqual(["chapter/one.tex"]);
  });

  it("refuses to guess about managed files it cannot see as files", async () => {
    const root = await folder({ "real.tex": "x", "sub/.git/HEAD": "ref", "sub/a.tex": "a" });
    await NodeFSP.symlink(NodePath.join(root, "real.tex"), NodePath.join(root, "main.tex"));
    expect(await refusal(root, { managedPaths: ["main.tex"] })).toEqual({
      reason: "not-a-file",
      path: "main.tex",
    });
    // Inside a nested repository is not a deletion to propagate.
    expect(await refusal(root, { managedPaths: ["sub/a.tex"] })).toEqual({
      reason: "managed-excluded",
      path: "sub/a.tex",
    });
    expect(await refusal(root, { selectedAdditions: ["absent.tex"] })).toEqual({
      reason: "not-selectable",
      path: "absent.tex",
    });
  });

  it("refuses an LFS pointer it would send, and leaves an unchecked one out", async () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n";
    const root = await folder({ "data.bin": pointer });
    expect(await refusal(root, { managedPaths: ["data.bin"] })).toEqual({
      reason: "lfs-pointer",
      path: "data.bin",
    });
    const inventory = await captured(root);
    expect(inventory.additions).toEqual([]);
    expect(inventory.excluded).toEqual([{ path: "data.bin", reason: "lfs-pointer" }]);
  });

  it("reads requested collision paths in full, local-only ones included", async () => {
    const root = await folder({ "private.txt": "mine", "main.aux": "aux" });
    const inventory = await captured(root, {
      localOnlyPaths: ["private.txt"],
      requestedPaths: ["private.txt", "main.aux"],
    });
    expect([...inventory.captured.keys()].sort()).toEqual(["main.aux", "private.txt"]);
    expect(inventory.localOnly).toEqual([]);
    expect(inventory.additions).toEqual([]);
  });

  it("enforces Overleaf's file size exactly, in decimal bytes", async () => {
    const root = await folder({});
    for (const [name, size] of [
      ["exact.pdf", OVERLEAF_LIMITS.fileBytes],
      ["over.pdf", OVERLEAF_LIMITS.fileBytes + 1],
    ] as const) {
      await NodeFSP.writeFile(NodePath.join(root, name), "");
      await NodeFSP.truncate(NodePath.join(root, name), size);
    }
    expect((await captured(root, { managedPaths: ["exact.pdf"] })).capturedBytes).toBe(50_000_000);
    expect(await refusal(root, { managedPaths: ["exact.pdf", "over.pdf"] })).toEqual({
      reason: "file-too-large",
      path: "over.pdf",
    });
    // An unchecked addition is only listed, so its size alone refuses nothing.
    expect((await captured(root)).additions.map((addition) => addition.size)).toEqual([
      50_000_000, 50_000_001,
    ]);
  });

  it("stops at the walk, file-count and total limits before reading past them", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`f${index}.tex`, "12345"]),
    );
    const root = await folder(files);
    const all = Object.keys(files);
    expect(await refusal(root, { limits: { walkEntries: 5 } })).toEqual({ reason: "walk-limit" });
    expect(await refusal(root, { managedPaths: all, limits: { managedFiles: 5 } })).toEqual({
      reason: "managed-limit",
    });
    expect(await refusal(root, { managedPaths: all, limits: { totalBytes: 29 } })).toEqual({
      reason: "total-too-large",
    });
    expect(
      (await captured(root, { managedPaths: all, limits: { totalBytes: 30 } })).capturedBytes,
    ).toBe(30);
  });

  it("fails a file that changes while it is read", async () => {
    const root = await folder({ "main.tex": "before" });
    expect(
      await refusal(root, {
        managedPaths: ["main.tex"],
        afterRead: () => NodeFSP.appendFile(NodePath.join(root, "main.tex"), " after"),
      }),
    ).toEqual({ reason: "unstable", path: "main.tex" });
  });

  it("reports a missing manuscript folder", async () => {
    const root = await folder({});
    expect(await refusal(NodePath.join(root, "absent"))).toEqual({ reason: "folder-unavailable" });
  });
  it("refuses a managed file that is on disk only under another spelling", async () => {
    const nfd = "e\u0301.tex";
    const root = await folder({ [nfd]: "x" });
    const names = await NodeFSP.readdir(root);
    // Some file systems normalize names; the test needs the decomposed spelling kept.
    if (!names.includes(nfd)) return;
    expect(await refusal(root, { managedPaths: ["\u00e9.tex"] })).toEqual({
      reason: "alias",
      path: "\u00e9.tex",
      onDisk: nfd,
    });
  });

  it("refuses a case-only variant of a managed file instead of deleting it", async () => {
    const root = await folder({ "Main.tex": "x" });
    if ((await NodeFSP.readdir(root)).includes("main.tex")) return;
    expect(await refusal(root, { managedPaths: ["main.tex"] })).toEqual({
      reason: "alias",
      path: "main.tex",
      onDisk: "Main.tex",
    });
  });

  it("fails when a folder above a file is swapped for a link while reading", async () => {
    const root = await folder({ "a.tex": "a", "sub/secret.txt": "inside" });
    const outside = await folder({ "secret.txt": "outside" });
    expect(
      await refusal(root, {
        managedPaths: ["a.tex", "sub/secret.txt"],
        afterRead: async (path) => {
          if (path !== "a.tex") return;
          await NodeFSP.rename(NodePath.join(root, "sub"), NodePath.join(root, "sub-moved"));
          await NodeFSP.symlink(outside, NodePath.join(root, "sub"));
        },
      }),
    ).toEqual({ reason: "unstable", path: "sub/secret.txt" });
  });
  it("fails when a folder is swapped for a link to an empty folder before it is listed", async () => {
    const root = await folder({ "main.tex": "m", "sub/chapter.tex": "c" });
    const outside = await folder({});
    expect(
      await refusal(root, {
        managedPaths: ["main.tex", "sub/chapter.tex"],
        beforeList: async (listed) => {
          if (listed !== "sub") return;
          await NodeFSP.rename(NodePath.join(root, "sub"), NodePath.join(root, "sub-moved"));
          await NodeFSP.symlink(outside, NodePath.join(root, "sub"));
        },
      }),
    ).toEqual({ reason: "unstable", path: "sub" });
  });
});
