// @effect-diagnostics nodeBuiltinImport:off -- Real manuscript folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import {
  captureOverleafInventory,
  OVERLEAF_LIMITS,
  overleafInventoryDigest,
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
    sendLocalOnly: [],
    requestedPaths: [],
    stagingPaths: [],
    atCheckoutTop: false,
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
      { path: ".latexmkrc", size: 2, checkedByDefault: false, uncheckedReason: "hidden" },
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

  it("skips Git's folders under every name the file layer refuses, and bare repositories", async () => {
    const root = await folder({
      "main.tex": "main",
      // Dotless i upcases to `.GIT`, as does any letter case.
      ".gıt/config": "x",
      ".GIT/config": "x",
      "GIT~1/config": "x",
      // A bare repository, and a linked worktree's Git folder, under ordinary names.
      ".bare/HEAD": "ref: refs/heads/main\n",
      ".bare/objects/info/packs": "",
      ".bare/refs/heads/main": "",
      ".bare/config": "x",
      "worktree/HEAD": "ref: refs/heads/main\n",
      "worktree/commondir": "../..\n",
      // Git's names alone do not make a repository.
      "notes/HEAD": "x",
      "notes/refs/a.bib": "x",
    });
    const inventory = await captured(root, { managedPaths: ["main.tex"] });
    expect(inventory.additions.map((addition) => addition.path)).toEqual([
      "notes/HEAD",
      "notes/refs/a.bib",
    ]);
    expect(inventory.excluded).toEqual([
      { path: ".GIT", reason: "reserved" },
      { path: ".bare", reason: "repository" },
      { path: ".gıt", reason: "reserved" },
      { path: "GIT~1", reason: "reserved" },
      { path: "worktree", reason: "repository" },
    ]);
  });

  it("refuses a manuscript folder inside Git's own folders", async () => {
    const bare = await folder({
      HEAD: "ref",
      "objects/x": "",
      "refs/x": "",
      "paper/main.tex": "m",
    });
    expect(await refusal(NodePath.join(bare, "paper"))).toEqual({ reason: "git-folder" });
    const named = await folder({ ".git/paper/main.tex": "m" });
    expect(await refusal(NodePath.join(named, ".git", "paper"))).toEqual({ reason: "git-folder" });
    // A linked worktree's top holds a `.git` file; what lies above it is not checked.
    const worktree = await folder({
      HEAD: "ref",
      commondir: "..",
      "wt/.git": "gitdir: x",
      "wt/a.tex": "a",
    });
    expect((await captured(NodePath.join(worktree, "wt"))).additions).toHaveLength(1);
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

  it("selects new files by default, skipping build output, hidden and Scient's own files", async () => {
    const files = {
      "main.tex": "main",
      "figures/plot.pdf": "pdf",
      "main.aux": "aux",
      ".env": "SECRET=1",
      ".latexmkrc": "rc",
      ".cache/notes.txt": "hidden folder",
      "drafts/.notes.md": "hidden name",
      "AGENTS.md": "agents",
      "PROJECT.md": "project",
      "chapters/AGENTS.md": "not at the top",
    };
    const root = await folder(files);
    const top = await captured(root, {
      atCheckoutTop: true,
      defaultSelection: { except: [], lenient: false },
    });
    expect(top.selectedAdditions.map((addition) => addition.path)).toEqual([
      "chapters/AGENTS.md",
      "figures/plot.pdf",
      "main.tex",
    ]);
    expect([...top.captured.keys()].sort()).toEqual([
      "chapters/AGENTS.md",
      "figures/plot.pdf",
      "main.tex",
    ]);
    expect(top.additions.map((addition) => [addition.path, addition.uncheckedReason])).toEqual([
      [".cache/notes.txt", "hidden"],
      [".env", "hidden"],
      [".latexmkrc", "hidden"],
      ["AGENTS.md", "scient-project-file"],
      ["PROJECT.md", "scient-project-file"],
      ["drafts/.notes.md", "hidden"],
      ["main.aux", "build-output"],
    ]);
    // Below the checkout's top, Scient's own file names are ordinary files.
    const below = await captured(root, { defaultSelection: { except: [], lenient: false } });
    expect(below.selectedAdditions.map((addition) => addition.path)).toContain("AGENTS.md");
    expect(below.selectedAdditions.map((addition) => addition.path)).toContain("PROJECT.md");
    // A default file named in `except` is left out, as an addition still checked by default.
    const kept = await captured(root, {
      defaultSelection: { except: ["main.tex"], lenient: false },
    });
    expect(kept.captured.has("main.tex")).toBe(false);
    expect(kept.additions).toContainEqual({
      path: "main.tex",
      size: 4,
      checkedByDefault: true,
      uncheckedReason: null,
    });
    // Without the default selection nothing is selected that was not named.
    expect((await captured(root)).selectedAdditions).toEqual([]);
    // A file a rule skips can still be selected explicitly.
    const env = await captured(root, { selectedAdditions: [".env"] });
    expect(env.captured.has(".env")).toBe(true);
    expect(env.selectedAdditions).toEqual([
      { path: ".env", size: 8, checkedByDefault: false, uncheckedReason: "hidden" },
    ]);
  });

  it("never reads a new file too large for Overleaf, and refuses selecting it", async () => {
    // Read even by prefix, this file would be recognized as an LFS pointer and excluded.
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n";
    const root = await folder({ "huge.bin": pointer, "kept.bin": "small" });
    const limits = { fileBytes: pointer.length - 1 };
    const inventory = await captured(root, {
      limits,
      localOnlyPaths: ["kept.bin"],
      defaultSelection: { except: [], lenient: false },
    });
    expect(inventory.excluded).toEqual([]);
    expect(inventory.captured.size).toBe(0);
    expect(inventory.additions).toEqual([
      {
        path: "huge.bin",
        size: pointer.length,
        checkedByDefault: false,
        uncheckedReason: "too-large",
      },
    ]);
    expect(await refusal(root, { limits, selectedAdditions: ["huge.bin"] })).toEqual({
      reason: "file-too-large",
      path: "huge.bin",
    });
    expect(
      await refusal(root, {
        limits: { fileBytes: 4 },
        localOnlyPaths: ["kept.bin"],
        sendLocalOnly: ["kept.bin"],
      }),
    ).toEqual({ reason: "file-too-large", path: "kept.bin" });
    // Rebuilt from an earlier review, a selected file that has grown too large is left out.
    const rebuilt = await captured(root, {
      limits,
      selectedAdditions: ["huge.bin"],
      defaultSelection: { except: [], lenient: true },
    });
    expect([...rebuilt.captured.keys()]).toEqual(["kept.bin"]);
    expect(rebuilt.additions.map((addition) => addition.path)).toEqual(["huge.bin"]);
  });

  it("skips Scient's own files at the top under any letter case", async () => {
    const root = await folder({ "agents.md": "a", "Project.MD": "p", "sub/agents.md": "s" });
    const inventory = await captured(root, {
      atCheckoutTop: true,
      defaultSelection: { except: [], lenient: false },
    });
    expect(inventory.selectedAdditions.map((addition) => addition.path)).toEqual(["sub/agents.md"]);
    expect(
      inventory.additions.map((addition) => [addition.path, addition.uncheckedReason]),
    ).toEqual([
      ["Project.MD", "scient-project-file"],
      ["agents.md", "scient-project-file"],
    ]);
  });

  it("judges a file that grew after the listing by the opened file, reading none of it", async () => {
    // Read even by prefix, the grown `.env` would be recognized as an LFS pointer and excluded.
    const pointer = `version https://git-lfs.github.com/spec/v1\n${"x".repeat(40)}\n`;
    const root = await folder({ "a.tex": "a", "sub/.env": "x", "sub/notes.txt": "n" });
    const limits = { fileBytes: pointer.length - 1 };
    const inventory = await captured(root, {
      limits,
      managedPaths: ["a.tex"],
      defaultSelection: { except: [], lenient: false },
      afterRead: async (path) => {
        if (path !== "a.tex") return;
        await NodeFSP.writeFile(NodePath.join(root, "sub/.env"), pointer);
        await NodeFSP.writeFile(NodePath.join(root, "sub/notes.txt"), pointer.replace("v", "w"));
      },
    });
    expect(inventory.excluded).toEqual([]);
    expect([...inventory.captured.keys()]).toEqual(["a.tex"]);
    expect(inventory.additions).toEqual([
      {
        path: "sub/.env",
        size: pointer.length,
        checkedByDefault: false,
        uncheckedReason: "too-large",
      },
      {
        path: "sub/notes.txt",
        size: pointer.length,
        checkedByDefault: false,
        uncheckedReason: "too-large",
      },
    ]);
  });

  it("keeps a deliberate deselection whatever the rule says of the file now", async () => {
    const root = await folder({ "big.txt": "0123456789", "notes.tex": "n", "main.aux": "aux" });
    const limits = { fileBytes: 5 };
    // Explicit selections: every default file left out is deliberate; rule-skipped ones are not.
    expect((await captured(root, { limits })).deselected).toEqual(["notes.tex"]);
    // A replacement review: big.txt was deselected before it grew too large.
    const rebuilt = await captured(root, {
      limits,
      defaultSelection: { except: ["big.txt", "gone.txt"], lenient: true },
    });
    expect(rebuilt.deselected).toEqual(["big.txt"]);
    expect([...rebuilt.captured.keys()]).toEqual(["notes.tex"]);
  });

  it("sends on request whatever the rule says, and keeps on request whatever it says", async () => {
    const root = await folder({
      "main.tex": "m",
      ".env": "e",
      "main.aux": "aux",
      "fig.tex": "f",
      "private.txt": "p",
      "big.bin": "0123456789",
    });
    const base = {
      limits: { fileBytes: 5 },
      managedPaths: ["main.tex"],
      localOnlyPaths: ["private.txt"],
      defaultSelection: { except: [], lenient: false },
    };
    const inventory = await captured(root, {
      ...base,
      // main.tex is already managed: nothing more to do.
      send: [".env", "private.txt", "main.tex", "fig.tex"],
      // Kept wins over send; a path that is not a new file is ignored.
      keepOnlyHere: ["fig.tex", "main.aux", "absent.txt"],
    });
    expect([...inventory.captured.keys()].sort()).toEqual([".env", "main.tex", "private.txt"]);
    expect(inventory.selectedAdditions.map((addition) => addition.path)).toEqual([".env"]);
    expect(inventory.sentLocalOnly).toEqual(["private.txt"]);
    // Rule-skipped main.aux is remembered because it was asked for; big.bin is not.
    expect(inventory.deselected).toEqual(["fig.tex", "main.aux"]);
    // Keeping a managed file here is not a new-file decision: it is still synced.
    expect(
      (await captured(root, { ...base, keepOnlyHere: ["main.tex"] })).captured.has("main.tex"),
    ).toBe(true);
    expect(await refusal(root, { ...base, send: ["big.bin"] })).toEqual({
      reason: "file-too-large",
      path: "big.bin",
    });
    expect(await refusal(root, { ...base, send: ["absent.txt"] })).toEqual({
      reason: "not-selectable",
      path: "absent.txt",
    });
    // With explicit selections too, keeping wins and is remembered.
    const explicit = await captured(root, {
      selectedAdditions: ["fig.tex"],
      keepOnlyHere: ["fig.tex", ".env"],
    });
    expect(explicit.selectedAdditions).toEqual([]);
    expect(explicit.deselected).toContain(".env");
    expect(explicit.deselected).toContain("fig.tex");
  });

  it("leaves an LFS pointer out of the default selection instead of refusing", async () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n";
    const root = await folder({ "data.bin": pointer, "main.tex": "m" });
    const inventory = await captured(root, { defaultSelection: { except: [], lenient: false } });
    expect([...inventory.captured.keys()]).toEqual(["main.tex"]);
    expect(inventory.excluded).toEqual([{ path: "data.bin", reason: "lfs-pointer" }]);
  });

  it("reads a local-only file being sent, and refuses one that is not local-only", async () => {
    const root = await folder({ "private.txt": "mine", "other.txt": "o", "new.tex": "n" });
    const inventory = await captured(root, {
      localOnlyPaths: ["private.txt", "other.txt", "gone.txt"],
      sendLocalOnly: ["private.txt"],
    });
    expect([...inventory.captured.keys()]).toEqual(["private.txt"]);
    expect(inventory.sentLocalOnly).toEqual(["private.txt"]);
    expect(inventory.localOnly).toEqual(["other.txt"]);
    const input = { localOnlyPaths: ["private.txt", "gone.txt"] };
    expect(await refusal(root, { ...input, sendLocalOnly: ["new.tex"] })).toEqual({
      reason: "not-local-only",
      path: "new.tex",
    });
    expect(await refusal(root, { ...input, sendLocalOnly: ["gone.txt"] })).toEqual({
      reason: "not-selectable",
      path: "gone.txt",
    });
    // A local-only file is not an addition: it is sent through its own list.
    expect(await refusal(root, { ...input, selectedAdditions: ["private.txt"] })).toEqual({
      reason: "not-selectable",
      path: "private.txt",
    });
    // Rebuilt from an earlier review, what is no longer selectable is left out.
    const lenient = await captured(root, {
      ...input,
      selectedAdditions: ["absent.tex"],
      sendLocalOnly: ["gone.txt", "new.tex"],
      defaultSelection: { except: [], lenient: true },
    });
    expect([...lenient.captured.keys()].sort()).toEqual(["new.tex", "other.txt"]);
    expect(lenient.sentLocalOnly).toEqual([]);
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

describe("overleafInventoryDigest", () => {
  it("is the same for the same folder and differs for any change a review reads", async () => {
    const root = await folder({ "main.tex": "main", "notes.md": "notes" });
    const input = { managedPaths: ["main.tex"] };
    const digest = async () => overleafInventoryDigest(await captured(root, input));
    const first = await digest();
    expect(await digest()).toBe(first);
    // The same size, other bytes.
    await NodeFSP.writeFile(NodePath.join(root, "main.tex"), "MAIN");
    const edited = await digest();
    expect(edited).not.toBe(first);
    // A new file, read or not.
    await NodeFSP.writeFile(NodePath.join(root, "build.log"), "log");
    const added = await digest();
    expect(added).not.toBe(edited);
    // A new empty folder.
    await NodeFSP.mkdir(NodePath.join(root, "figures"));
    expect(await digest()).not.toBe(added);
  });
});
