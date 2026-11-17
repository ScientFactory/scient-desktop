// @effect-diagnostics nodeBuiltinImport:off -- Exercises real folders and links.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it } from "@effect/vitest";

import { removeRetiredJournalIconCache } from "./RetiredJournalIconCache.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0))
    await NodeFSP.rm(fixture, { recursive: true, force: true });
});

async function stateDir() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icon-cache-")),
  );
  fixtures.push(base);
  return base;
}

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

it("removes only the retired icon folder and leaves its siblings", async () => {
  const state = await stateDir();
  const icons = NodePath.join(state, "scient", "journal-icons");
  await NodeFSP.mkdir(NodePath.join(icons, "v1", "abc"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(icons, "v1", "abc", "icon.png"), "png");
  await NodeFSP.mkdir(NodePath.join(icons, "v2"), { recursive: true });

  expect(await removeRetiredJournalIconCache(state)).toBe(true);
  expect(await exists(NodePath.join(icons, "v1"))).toBe(false);
  expect(await exists(NodePath.join(icons, "v2"))).toBe(true);
  expect(await removeRetiredJournalIconCache(state)).toBe(false);
});

// A junction on Windows needs no symlink privilege; other systems ignore the type.
const linkFolder = (target: string, path: string) => NodeFSP.symlink(target, path, "junction");

it("leaves the folder alone when an ancestor or the folder itself is a link", async () => {
  const state = await stateDir();
  const elsewhere = await stateDir();
  await NodeFSP.mkdir(NodePath.join(elsewhere, "v1"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(elsewhere, "v1", "keep.txt"), "keep");
  await NodeFSP.mkdir(NodePath.join(state, "scient"), { recursive: true });
  await linkFolder(elsewhere, NodePath.join(state, "scient", "journal-icons"));
  expect(await removeRetiredJournalIconCache(state)).toBe(false);
  expect(await exists(NodePath.join(elsewhere, "v1", "keep.txt"))).toBe(true);

  const other = await stateDir();
  await NodeFSP.mkdir(NodePath.join(other, "scient", "journal-icons"), { recursive: true });
  await linkFolder(
    NodePath.join(elsewhere, "v1"),
    NodePath.join(other, "scient", "journal-icons", "v1"),
  );
  expect(await removeRetiredJournalIconCache(other)).toBe(false);
  expect(await exists(NodePath.join(elsewhere, "v1", "keep.txt"))).toBe(true);
});
